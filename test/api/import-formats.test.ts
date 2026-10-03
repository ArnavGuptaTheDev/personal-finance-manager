import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, makeUser } from './helpers';

let erin: Awaited<ReturnType<typeof makeUser>>;
let frank: Awaited<ReturnType<typeof makeUser>>;

const mapping = {
  version: 1,
  columns: { date: 'Txn Date', description: 'Details', debit: 'Paid Out', credit: 'Paid In', balance: 'Balance' },
  amounts: 'split',
  dateOrder: 'dmy',
};

beforeAll(async () => {
  erin = await makeUser('erin@test.com', { grant: true });
  frank = await makeUser('frank@test.com', { grant: true });
});

describe('saved import formats', () => {
  it('saves, lists, deletes and restores a format', async () => {
    const created = await call('POST', '/import-formats', { token: erin.token, body: { name: 'Test Bank savings', mapping } });
    expect(created.status).toBe(201);
    expect(created.json.mapping).toEqual(mapping);
    const list = await call('GET', '/import-formats', { token: erin.token });
    expect(list.json.map((f: { name: string }) => f.name)).toContain('Test Bank savings');

    expect((await call('POST', '/import-formats', { token: erin.token, body: { name: 'test bank SAVINGS', mapping } })).status).toBe(409);

    expect((await call('DELETE', `/import-formats/${created.json.id}`, { token: erin.token })).status).toBe(204);
    expect((await call('GET', '/import-formats', { token: erin.token })).json).toEqual([]);
    expect((await call('POST', `/import-formats/${created.json.id}/restore`, { token: erin.token })).status).toBe(200);
    expect((await call('GET', '/import-formats', { token: erin.token })).json).toHaveLength(1);
  });

  it('stores column titles and rules only: anything else is refused', async () => {
    const attempts = [
      { ...mapping, rows: [['01/04/2026', 'SALARY', '50000']] },
      { ...mapping, columns: { ...mapping.columns, sample: '01/04/2026 SALARY 50000' } },
      { ...mapping, columns: { ...mapping.columns, date: 'x'.repeat(81) } },
      { ...mapping, amounts: 'guess' },
      { ...mapping, columns: { date: 'Date', description: 'Details' } },
      { ...mapping, amounts: 'marker', columns: { date: 'Date', description: 'Details', amount: 'Amount' } },
    ];
    for (const m of attempts) {
      const res = await call('POST', '/import-formats', { token: erin.token, body: { name: `Bad ${crypto.randomUUID().slice(0, 6)}`, mapping: m } });
      expect(res.status, JSON.stringify(m).slice(0, 80)).toBe(400);
    }
  });

  it('is private to its owner', async () => {
    const created = await call('POST', '/import-formats', { token: erin.token, body: { name: 'Erin only', mapping } });
    const id = created.json.id as number;
    expect((await call('GET', '/import-formats', { token: frank.token })).json.some((f: { id: number }) => f.id === id)).toBe(false);
    expect((await call('DELETE', `/import-formats/${id}`, { token: frank.token })).status).toBe(404);
    await call('DELETE', `/import-formats/${id}`, { token: erin.token });
    expect((await call('POST', `/import-formats/${id}/restore`, { token: frank.token })).status).toBe(404);
    const row = await env.DB.prepare('SELECT deleted_at FROM import_formats WHERE id = ?').bind(id).first();
    expect(row?.deleted_at).not.toBeNull();
    const exp = await call('GET', '/me/export', { token: frank.token });
    expect(JSON.stringify(exp.json)).not.toContain('Erin only');
  });

  it('is part of the owner’s export', async () => {
    const u = await makeUser('export-formats@test.com', { grant: true });
    await call('POST', '/import-formats', { token: u.token, body: { name: 'Mine', mapping } });
    const exp = await call('GET', '/me/export', { token: u.token });
    expect(exp.json.import_formats).toEqual([{ name: 'Mine', mapping }]);
  });
});
