import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, makeUser, txn } from './helpers';

describe('merchants', () => {
  it('are stored on create, import and description edits', async () => {
    const u = await makeUser('merchant@test.com', { grant: true });
    const t = await call('POST', '/transactions', { token: u.token, body: txn({ description: 'UPI-SWIGGY-SWIGGY8@YBL-412398712' }) });
    expect(t.json.merchant).toBe('Swiggy');
    await call('POST', '/transactions/bulk', { token: u.token, body: [txn({ description: 'POS 416021XXXXXX1234 BLINKIT', bank: 'hdfc' })] });
    const list = await call('GET', '/transactions', { token: u.token });
    expect(list.json.items.map((x: { merchant: string }) => x.merchant).sort()).toEqual(['Blinkit', 'Swiggy']);
    const edited = await call('PATCH', `/transactions/${t.json.id}`, { token: u.token, body: { description: 'UPI/ZOMATO/123' } });
    expect(edited.json.merchant).toBe('Zomato');
  });

  it('are backfilled for older rows in batches', async () => {
    const u = await makeUser('backfill@test.com', { grant: true });
    for (let i = 0; i < 3; i++) await call('POST', '/transactions', { token: u.token, body: txn({ description: `UPI-CHAI POINT-${i}` }) });
    await env.DB.prepare('UPDATE transactions SET merchant = NULL WHERE user_id = ?').bind(u.id).run();
    const res = await call('POST', '/transactions/merchants/backfill', { token: u.token, body: {} });
    expect(res.json).toEqual({ updated: 3, remaining: 0 });
    const rows = await env.DB.prepare('SELECT DISTINCT merchant FROM transactions WHERE user_id = ?').bind(u.id).all();
    expect(rows.results).toEqual([{ merchant: 'Chai Point' }]);
  });
});

describe('rules from corrections', () => {
  it('preview counts match what applying the rule changes', async () => {
    const u = await makeUser('rule@test.com', { grant: true });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await call('POST', '/transactions', { token: u.token, body: txn({ description: `UPI-SWIGGY-S${i}@YBL-${400000 + i}` }) })).json.id);
    await call('POST', '/transactions', { token: u.token, body: txn({ description: 'UPI-ZOMATO-Z@YBL-500000' }) });
    await call('PATCH', `/transactions/${ids[0]}`, { token: u.token, body: { category_id: 1 } });

    const preview = await call('GET', '/transactions/rule-preview?merchant=Swiggy&category_id=1', { token: u.token });
    expect(preview.json).toEqual({ matches: 4, changes: 3 });
    const applied = await call('POST', '/transactions/apply-rule', { token: u.token, body: { merchant: 'swiggy', category_id: 1 } });
    expect(applied.json.updated).toBe(preview.json.changes);
    expect((await call('GET', '/transactions/rule-preview?merchant=Swiggy&category_id=1', { token: u.token })).json).toEqual({ matches: 4, changes: 0 });
    const zomato = await env.DB.prepare("SELECT category_id FROM transactions WHERE user_id = ? AND merchant = 'Zomato'").bind(u.id).first();
    expect(zomato?.category_id).toBeNull();
  });

  it('suggests the category you chose most often for a merchant', async () => {
    const u = await makeUser('suggest@test.com', { grant: true });
    for (const cat of [1, 1, 1, 2]) await call('POST', '/transactions', { token: u.token, body: txn({ description: 'UPI-SWIGGY-S@YBL-1', category_id: cat }) });
    const res = await call('POST', '/transactions/suggest', { token: u.token, body: { merchants: ['Swiggy', 'Nobody'] } });
    expect(res.json.suggestions).toEqual({ swiggy: { category_id: 1, name: 'Food & Dining', times: 3 } });
  });

  it('never reads or changes another user’s transactions', async () => {
    const a = await makeUser('rule-a@test.com', { grant: true });
    const b = await makeUser('rule-b@test.com', { grant: true });
    await call('POST', '/transactions', { token: a.token, body: txn({ description: 'UPI-SECRETSHOP-X@YBL-1', category_id: 3 }) });
    expect((await call('GET', '/transactions/rule-preview?merchant=Secretshop&category_id=1', { token: b.token })).json.matches).toBe(0);
    expect((await call('POST', '/transactions/apply-rule', { token: b.token, body: { merchant: 'Secretshop', category_id: 1 } })).json.updated).toBe(0);
    expect((await call('POST', '/transactions/suggest', { token: b.token, body: { merchants: ['Secretshop'] } })).json.suggestions).toEqual({});
    expect((await call('GET', '/transactions/texts', { token: b.token })).json.some((t: { description: string }) => t.description.includes('SECRETSHOP'))).toBe(false);
    const own = await env.DB.prepare("SELECT category_id FROM transactions WHERE user_id = ? AND merchant = 'Secretshop'").bind(a.id).first();
    expect(own?.category_id).toBe(3);
  });

  it('refuses a category the user cannot use', async () => {
    const u = await makeUser('rule-cat@test.com', { grant: true });
    expect((await call('POST', '/transactions/apply-rule', { token: u.token, body: { merchant: 'Swiggy', category_id: 99999 } })).status).toBe(400);
  });
});

describe('transfer pairs', () => {
  it('are found, confirmed, excluded from totals and can be undone', async () => {
    const u = await makeUser('pairs@test.com', { grant: true });
    const out = await call('POST', '/transactions', { token: u.token, body: txn({ amount: 5000, date: '2026-09-10', description: 'NEFT TO OWN ICICI', bank: 'hdfc', account_last4: '1111' }) });
    const into = await call('POST', '/transactions', { token: u.token, body: txn({ amount: 5000, type: 'credit', date: '2026-09-11', description: 'NEFT FROM OWN HDFC', bank: 'icici', account_last4: '2222' }) });
    // Same amount but same account, or 5 days apart: not candidates.
    await call('POST', '/transactions', { token: u.token, body: txn({ amount: 5000, type: 'credit', date: '2026-09-10', description: 'REFUND', bank: 'hdfc', account_last4: '1111' }) });
    await call('POST', '/transactions', { token: u.token, body: txn({ amount: 5000, type: 'credit', date: '2026-09-20', description: 'LATE', bank: 'sbi', account_last4: '3333' }) });

    const before = (await call('GET', '/summary', { token: u.token })).json;
    const pairs = await call('GET', '/transactions/pairs', { token: u.token });
    expect(pairs.json).toEqual([
      expect.objectContaining({ amount: 5000, debit: expect.objectContaining({ id: out.json.id }), credit: expect.objectContaining({ id: into.json.id }) }),
    ]);

    const made = await call('POST', '/transactions/pairs', { token: u.token, body: { debit_id: out.json.id, credit_id: into.json.id, kind: 'self_transfer' } });
    expect(made.status).toBe(201);
    const after = (await call('GET', '/summary', { token: u.token })).json;
    expect(after.spend).toBe(before.spend - 5000);
    expect(after.income).toBe(before.income - 5000);
    expect((await call('GET', '/transactions/pairs', { token: u.token })).json).toEqual([]);
    // Recategorising one half doesn't bring it back into the totals while it is paired.
    await call('PATCH', `/transactions/${out.json.id}`, { token: u.token, body: { category_id: 3 } });
    expect((await call('GET', '/summary', { token: u.token })).json.spend).toBe(after.spend);

    expect((await call('DELETE', `/transactions/pairs/${made.json.pair_id}`, { token: u.token })).status).toBe(204);
    const rows = await env.DB.prepare('SELECT transfer_pair_id FROM transactions WHERE id IN (?, ?)').bind(out.json.id, into.json.id).all();
    expect(rows.results.every((r) => r.transfer_pair_id === null)).toBe(true);
  });

  it('cannot pair, see or unpair another user’s transactions', async () => {
    const a = await makeUser('pair-a@test.com', { grant: true });
    const b = await makeUser('pair-b@test.com', { grant: true });
    const d = await call('POST', '/transactions', { token: a.token, body: txn({ amount: 700, bank: 'hdfc' }) });
    const k = await call('POST', '/transactions', { token: a.token, body: txn({ amount: 700, type: 'credit', bank: 'icici' }) });
    expect((await call('GET', '/transactions/pairs', { token: b.token })).json).toEqual([]);
    expect((await call('POST', '/transactions/pairs', { token: b.token, body: { debit_id: d.json.id, credit_id: k.json.id, kind: 'self_transfer' } })).status).toBe(404);
    const made = await call('POST', '/transactions/pairs', { token: a.token, body: { debit_id: d.json.id, credit_id: k.json.id, kind: 'card_payment' } });
    expect((await call('DELETE', `/transactions/pairs/${made.json.pair_id}`, { token: b.token })).status).toBe(404);
    const row = await env.DB.prepare('SELECT transfer_pair_id, category_id FROM transactions WHERE id = ?').bind(k.json.id).first();
    expect(row).toEqual({ transfer_pair_id: d.json.id, category_id: 17 });
  });

  it('refuses mismatched amounts and directions', async () => {
    const u = await makeUser('pair-bad@test.com', { grant: true });
    const d = await call('POST', '/transactions', { token: u.token, body: txn({ amount: 100 }) });
    const k = await call('POST', '/transactions', { token: u.token, body: txn({ amount: 101, type: 'credit', bank: 'x' }) });
    expect((await call('POST', '/transactions/pairs', { token: u.token, body: { debit_id: d.json.id, credit_id: k.json.id, kind: 'self_transfer' } })).status).toBe(400);
    expect((await call('POST', '/transactions/pairs', { token: u.token, body: { debit_id: k.json.id, credit_id: d.json.id, kind: 'self_transfer' } })).status).toBe(404);
  });
});
