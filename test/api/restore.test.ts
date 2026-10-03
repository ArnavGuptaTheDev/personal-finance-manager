import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, makeUser, txn } from './helpers';

let carol: Awaited<ReturnType<typeof makeUser>>;
let dave: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  carol = await makeUser('carol@test.com', { grant: true });
  dave = await makeUser('dave@test.com', { grant: true });
});

async function records(token: string) {
  const t = await call('POST', '/transactions', { token, body: txn({ description: 'UNDO ME' }) });
  const cat = await call('POST', '/categories', { token, body: { name: `Undo cat ${crypto.randomUUID().slice(0, 6)}` } });
  const kw = await call('POST', `/categories/${cat.json.id}/keywords`, { token, body: { keyword: 'undoword' } });
  const bud = await call('PUT', '/budgets', { token, body: { category_id: 2, amount: 500 } });
  const person = await call('POST', '/people', { token, body: { name: 'Undo Friend' } });
  const loan = await call('POST', '/loans', {
    token,
    body: { person_id: person.json.id, direction: 'lent', title: 'Undo loan', amount: 100, date: '2026-09-01' },
  });
  const pay = await call('POST', `/loans/${loan.json.id}/payments`, { token, body: { amount: 10, date: '2026-09-02' } });
  const emi = await call('POST', '/emis', {
    token,
    body: { title: 'Undo EMI', installment: 100, frequency_unit: 'months', start_date: '2026-01-01', end_date: '2026-12-01' },
  });
  return { txn: t.json.id, cat: cat.json.id, kw: kw.json.id, bud: bud.json.id, person: person.json.id, loan: loan.json.id, pay: pay.json.id, emi: emi.json.id };
}

const paths = (r: Awaited<ReturnType<typeof records>>) => ({
  txn: `/transactions/${r.txn}`,
  cat: `/categories/${r.cat}`,
  kw: `/categories/keywords/${r.kw}`,
  bud: `/budgets/${r.bud}`,
  person: `/people/${r.person}`,
  loan: `/loans/${r.loan}`,
  pay: `/loans/${r.loan}/payments/${r.pay}`,
  emi: `/emis/${r.emi}`,
});

describe('soft delete and restore', () => {
  it('a deleted record disappears from lists and comes back on restore', async () => {
    const r = await records(carol.token);
    const token = carol.token;
    for (const [kind, path] of Object.entries(paths(r))) {
      expect((await call('DELETE', path, { token })).status, `delete ${kind}`).toBe(204);
      expect((await call('DELETE', path, { token })).status, `second delete ${kind}`).toBe(404);
    }

    const tx = await call('GET', '/transactions?limit=200', { token });
    expect(tx.json.items.some((t: { id: number }) => t.id === r.txn)).toBe(false);
    const cats = await call('GET', '/categories', { token });
    expect(cats.json.some((c: { id: number }) => c.id === r.cat)).toBe(false);
    expect(cats.json.flatMap((c: { keywords: { id: number }[] }) => c.keywords).some((k: { id: number }) => k.id === r.kw)).toBe(false);
    expect((await call('GET', '/budgets', { token })).json.items.some((b: { id: number }) => b.id === r.bud)).toBe(false);
    expect((await call('GET', '/people', { token })).json.some((p: { id: number }) => p.id === r.person)).toBe(false);
    expect((await call('GET', '/loans', { token })).json.some((l: { id: number }) => l.id === r.loan)).toBe(false);
    expect((await call('GET', '/emis', { token })).json.some((e: { id: number }) => e.id === r.emi)).toBe(false);
    expect(JSON.stringify((await call('GET', '/me/export', { token })).json)).not.toContain('UNDO ME');

    for (const [kind, path] of Object.entries(paths(r))) {
      expect((await call('POST', `${path}/restore`, { token })).status, `restore ${kind}`).toBe(200);
      expect((await call('POST', `${path}/restore`, { token })).status, `second restore ${kind}`).toBe(404);
    }
    expect((await call('GET', '/transactions?limit=200', { token })).json.items.some((t: { id: number }) => t.id === r.txn)).toBe(true);
    const loans = (await call('GET', '/loans', { token })).json as { id: number; paid: number }[];
    expect(loans.find((l) => l.id === r.loan)?.paid).toBe(10);
    expect((await call('GET', '/emis', { token })).json.some((e: { id: number }) => e.id === r.emi)).toBe(true);
  });

  it('nobody can restore another user’s deleted records', async () => {
    const r = await records(carol.token);
    for (const path of Object.values(paths(r))) await call('DELETE', path, { token: carol.token });
    for (const [kind, path] of Object.entries(paths(r))) {
      expect((await call('POST', `${path}/restore`, { token: dave.token })).status, `restore ${kind}`).toBe(404);
    }
    const bulk = await call('POST', '/transactions/restore', { token: dave.token, body: { ids: [r.txn] } });
    expect(bulk.json.restored).toBe(0);
    const still = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM transactions WHERE id = ?1 AND deleted_at IS NOT NULL) + (SELECT COUNT(*) FROM categories WHERE id = ?2 AND deleted_at IS NOT NULL)
            + (SELECT COUNT(*) FROM people WHERE id = ?3 AND deleted_at IS NOT NULL) + (SELECT COUNT(*) FROM loans WHERE id = ?4 AND deleted_at IS NOT NULL)
            + (SELECT COUNT(*) FROM loan_payments WHERE id = ?5 AND deleted_at IS NOT NULL) + (SELECT COUNT(*) FROM emis WHERE id = ?6 AND deleted_at IS NOT NULL)
            + (SELECT COUNT(*) FROM budgets WHERE id = ?7 AND deleted_at IS NOT NULL) + (SELECT COUNT(*) FROM category_keywords WHERE id = ?8 AND deleted_at IS NOT NULL) AS n`,
    )
      .bind(r.txn, r.cat, r.person, r.loan, r.pay, r.emi, r.bud, r.kw)
      .first<{ n: number }>();
    expect(still?.n).toBe(8);
  });

  it('nobody can delete another user’s records in bulk', async () => {
    const t = await call('POST', '/transactions', { token: carol.token, body: txn({ description: 'CAROL BULK' }) });
    const res = await call('POST', '/transactions/delete', { token: dave.token, body: { ids: [t.json.id] } });
    expect(res.json.deleted).toBe(0);
    const row = await env.DB.prepare('SELECT deleted_at FROM transactions WHERE id = ?').bind(t.json.id).first();
    expect(row?.deleted_at).toBeNull();
  });

  it('bulk delete and bulk restore round-trip', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await call('POST', '/transactions', { token: carol.token, body: txn({ description: `BULK ${i}` }) })).json.id);
    expect((await call('POST', '/transactions/delete', { token: carol.token, body: { ids } })).json.deleted).toBe(3);
    expect((await call('POST', '/transactions/restore', { token: carol.token, body: { ids } })).json.restored).toBe(3);
  });

  it('a deleted category reads as Uncategorized and its name can be reused', async () => {
    const cat = await call('POST', '/categories', { token: carol.token, body: { name: 'Reusable' } });
    const t = await call('POST', '/transactions', { token: carol.token, body: txn({ description: 'IN REUSABLE', category_id: cat.json.id }) });
    await call('DELETE', `/categories/${cat.json.id}`, { token: carol.token });
    const list = await call('GET', '/transactions?category=none&limit=200', { token: carol.token });
    const row = list.json.items.find((x: { id: number }) => x.id === t.json.id);
    expect(row?.category_id).toBeNull();
    expect((await call('POST', '/categories', { token: carol.token, body: { name: 'Reusable' } })).status).toBe(201);
  });

  it('re-importing a deleted row restores it instead of adding a copy', async () => {
    const row = txn({ description: 'REIMPORT ME', date: '2026-08-01', bank: 'hdfc' });
    expect((await call('POST', '/transactions/bulk', { token: carol.token, body: [row] })).json.inserted).toBe(1);
    const stored = await env.DB.prepare("SELECT id FROM transactions WHERE user_id = ? AND description = 'REIMPORT ME'").bind(carol.id).first<{ id: number }>();
    await call('DELETE', `/transactions/${stored!.id}`, { token: carol.token });
    const rec = await call('POST', '/transactions/reconcile', { token: carol.token, body: { rows: [row] } });
    expect(rec.json.results[0].status).toBe('new');
    expect((await call('POST', '/transactions/bulk', { token: carol.token, body: [row] })).json.inserted).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND description = 'REIMPORT ME' AND deleted_at IS NULL")
      .bind(carol.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe('small fixes', () => {
  it('budget spent is net of refunds and never negative (B6)', async () => {
    const u = await makeUser('budget-net@test.com', { grant: true });
    await call('PUT', '/budgets', { token: u.token, body: { category_id: 3, amount: 1000 } });
    await call('POST', '/transactions', { token: u.token, body: txn({ category_id: 3, amount: 700, date: '2026-09-05' }) });
    await call('POST', '/transactions', { token: u.token, body: txn({ category_id: 3, amount: 200, type: 'credit', date: '2026-09-06' }) });
    let b = await call('GET', '/budgets?month=2026-09', { token: u.token });
    expect(b.json.items[0].spent).toBe(500);
    await call('POST', '/transactions', { token: u.token, body: txn({ category_id: 3, amount: 900, type: 'credit', date: '2026-09-07' }) });
    b = await call('GET', '/budgets?month=2026-09', { token: u.token });
    expect(b.json.items[0].spent).toBe(0);
  });

  it('the uncategorized count only counts debits (B7)', async () => {
    const u = await makeUser('uncat@test.com', { grant: true });
    await call('POST', '/transactions', { token: u.token, body: txn() });
    await call('POST', '/transactions', { token: u.token, body: txn({ type: 'credit' }) });
    expect((await call('GET', '/summary', { token: u.token })).json.uncategorized).toBe(1);
  });

  it('EMIs use the date the client sends (B5)', async () => {
    const u = await makeUser('emi-date@test.com', { grant: true });
    await call('POST', '/emis', {
      token: u.token,
      body: { title: 'Phone', installment: 100, frequency_unit: 'months', start_date: '2026-01-10', end_date: '2026-12-10' },
    });
    const before = await call('GET', '/emis?today=2026-03-09', { token: u.token });
    expect(before.json[0].next_due).toBe('2026-03-10');
    const after = await call('GET', '/emis?today=2026-03-11', { token: u.token });
    expect(after.json[0].next_due).toBe('2026-04-10');
  });

  it('the transaction list returns totals for the whole filtered view', async () => {
    const u = await makeUser('totals@test.com', { grant: true });
    for (let i = 0; i < 3; i++) await call('POST', '/transactions', { token: u.token, body: txn({ amount: 100 }) });
    await call('POST', '/transactions', { token: u.token, body: txn({ amount: 50, type: 'credit' }) });
    const res = await call('GET', '/transactions?limit=1', { token: u.token });
    expect(res.json.totals).toEqual({ debit: 300, credit: 50 });
  });

  it('a CSRF-blocked request is logged with the user its cookie belongs to (B9)', async () => {
    const u = await makeUser('csrf-log@test.com', { grant: true });
    const res = await call('POST', '/transactions', { token: u.token, body: txn(), origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT user_id FROM audit_logs WHERE path = '/api/transactions' AND status = 403 ORDER BY id DESC LIMIT 1").first();
    expect(row?.user_id).toBe(u.id);
  });
});
