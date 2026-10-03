import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { purgeAuditLog, purgeDeletedRecords, runRetention, UNDO_DAYS } from '../../server/lib/retention';
import { call, makeUser, txn } from './helpers';

const DAY = 86_400;
const count = async (sql: string, ...args: (string | number)[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
const addEntry = (createdAt: number, action = 'test.entry') =>
  env.DB.prepare("INSERT INTO audit_logs (created_at, action, outcome) VALUES (?, ?, 'success')").bind(createdAt, action).run();

describe('audit log stays append-only on every normal path', () => {
  it('refuses deletes and updates outside the purge window', async () => {
    await addEntry(Math.floor(Date.now() / 1000));
    await expect(env.DB.prepare('DELETE FROM audit_logs').run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("UPDATE audit_logs SET action = 'x'").run()).rejects.toThrow(/append-only/);
    // A batch that tries to delete without opening the window is rolled back as a whole.
    await expect(env.DB.batch([env.DB.prepare("INSERT INTO audit_logs (action, outcome) VALUES ('a', 'success')"), env.DB.prepare('DELETE FROM audit_logs')])).rejects.toThrow();
    expect(await count('SELECT COUNT(*) AS n FROM audit_purge_window')).toBe(0);
  });

  it('API requests never open the purge window', async () => {
    const u = await makeUser('retention-api@test.com', { grant: true });
    for (const [m, p] of [['GET', '/me'], ['GET', '/me/activity'], ['POST', '/transactions'], ['DELETE', '/me']] as const) {
      await call(m, p, { token: u.token, body: m === 'POST' ? txn() : undefined });
    }
    expect(await count('SELECT COUNT(*) AS n FROM audit_purge_window')).toBe(0);
    await expect(env.DB.prepare('DELETE FROM audit_logs').run()).rejects.toThrow(/append-only/);
  });
});

describe('audit retention job', () => {
  it('deletes exactly the entries older than the retention period and records a summary', async () => {
    for (const t of [100, 200, 300]) await addEntry(t, 'test.old');
    for (const t of [10_000, 20_000]) await addEntry(t, 'test.kept');
    const before = await count('SELECT COUNT(*) AS n FROM audit_logs');

    const res = await purgeAuditLog(env.DB, { retentionDays: 400, maxRows: 1_000_000, now: 5_000 + 400 * DAY });
    expect(res).toEqual({ removed: 3, trimmed: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'test.old'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'test.kept'")).toBe(2);
    expect(await count('SELECT COUNT(*) AS n FROM audit_logs')).toBe(before - 3 + 1);
    const summary = await env.DB.prepare("SELECT detail, user_id FROM audit_logs WHERE action = 'audit.purge' ORDER BY id DESC LIMIT 1").first<{ detail: string; user_id: number | null }>();
    expect(JSON.parse(summary!.detail)).toEqual({ removed: 3, older_than: '1970-01-01', trimmed: 0 });
    expect(summary!.user_id).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM audit_purge_window')).toBe(0);
  });

  it('does nothing (and writes no summary) when nothing is due', async () => {
    const before = await count('SELECT COUNT(*) AS n FROM audit_logs');
    expect(await purgeAuditLog(env.DB, { retentionDays: 400, maxRows: 1_000_000, now: 1 })).toEqual({ removed: 0, trimmed: 0 });
    expect(await count('SELECT COUNT(*) AS n FROM audit_logs')).toBe(before);
  });

  it('trims the oldest entries beyond the row cap', async () => {
    for (let i = 0; i < 3; i++) await addEntry(Math.floor(Date.now() / 1000), 'test.cap');
    const total = await count('SELECT COUNT(*) AS n FROM audit_logs');
    const oldest = await env.DB.prepare('SELECT id FROM audit_logs ORDER BY id LIMIT 2').all<{ id: number }>();
    const res = await purgeAuditLog(env.DB, { retentionDays: 100_000, maxRows: total - 2, now: Math.floor(Date.now() / 1000) });
    expect(res).toEqual({ removed: 0, trimmed: 2 });
    expect(await count('SELECT COUNT(*) AS n FROM audit_logs')).toBe(total - 2 + 1);
    for (const { id } of oldest.results) expect(await count('SELECT COUNT(*) AS n FROM audit_logs WHERE id = ?', id)).toBe(0);
  });
});

describe('purge of deleted records', () => {
  it('erases rows deleted more than 30 days ago and keeps everything else', async () => {
    const u = await makeUser('purge@test.com', { grant: true });
    const now = Math.floor(Date.now() / 1000);
    const make = async (description: string) => (await call('POST', '/transactions', { token: u.token, body: txn({ description }) })).json.id as number;
    const [live, recent, old] = [await make('LIVE'), await make('RECENT'), await make('OLD')];
    await env.DB.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').bind(now - 2 * DAY, recent).run();
    await env.DB.prepare('UPDATE transactions SET deleted_at = ? WHERE id = ?').bind(now - (UNDO_DAYS + 1) * DAY, old).run();
    const person = (await call('POST', '/people', { token: u.token, body: { name: 'Gone' } })).json.id as number;
    await call('POST', '/loans', { token: u.token, body: { person_id: person, direction: 'lent', title: 'L', amount: 5, date: '2026-01-01' } });
    await env.DB.prepare('UPDATE people SET deleted_at = ? WHERE id = ?').bind(now - (UNDO_DAYS + 5) * DAY, person).run();

    const erased = await purgeDeletedRecords(env.DB, now);
    // D1 counts rows removed by ON DELETE CASCADE too (the person's loan), so check the rows themselves.
    expect(erased.transactions).toBe(1);
    expect(erased.people).toBeGreaterThanOrEqual(1);
    expect(await count('SELECT COUNT(*) AS n FROM people WHERE id = ?', person)).toBe(0);
    const ids = (await env.DB.prepare('SELECT id FROM transactions WHERE user_id = ?').bind(u.id).all<{ id: number }>()).results.map((r) => r.id);
    expect(ids.sort()).toEqual([live, recent].sort());
    expect(await count('SELECT COUNT(*) AS n FROM loans WHERE user_id = ?', u.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'retention.purge_deleted'")).toBeGreaterThan(0);
  });

  it('the scheduled entry point runs both jobs', async () => {
    const res = await runRetention(env);
    expect(res).toHaveProperty('audit');
    expect(res).toHaveProperty('deleted');
  });
});
