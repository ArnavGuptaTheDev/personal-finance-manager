import { beforeAll, describe, expect, it } from 'vitest';
import { call, makeUser } from './helpers';

const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-04-05',
  amount: 450,
  type: 'debit',
  description: 'UPI-SWIGGY-SWIGGY8@YBL-LONG NARRATION',
  bank: 'hdfc',
  account_type: 'savings',
  account_last4: '1234',
  ...over,
});

let u: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;

async function reconcile(token: string, rows: Record<string, unknown>[]) {
  const res = await call('POST', '/transactions/reconcile', { token, body: { rows } });
  expect(res.status).toBe(200);
  return res.json.results as { status: string; changes?: string[]; match?: { id: number; date: string } }[];
}

beforeAll(async () => {
  u = await makeUser('recon@test.com', { grant: true });
  other = await makeUser('recon-other@test.com', { grant: true });
});

describe('reconcile before import', () => {
  it('marks identical rows as duplicates and unseen rows as new', async () => {
    await call('POST', '/transactions/bulk', { token: u.token, body: [row({ description: 'EXACT ONE' })] });
    const r = await reconcile(u.token, [row({ description: 'EXACT ONE' }), row({ description: 'BRAND NEW', amount: 99 })]);
    expect(r.map((x) => x.status)).toEqual(['duplicate', 'new']);
  });

  it('keeps genuine repeats within one statement as new', async () => {
    await call('POST', '/transactions/bulk', { token: u.token, body: [row({ description: 'TEA STALL', amount: 20 })] });
    const r = await reconcile(u.token, [row({ description: 'TEA STALL', amount: 20 }), row({ description: 'TEA STALL', amount: 20 })]);
    expect(r.map((x) => x.status)).toEqual(['duplicate', 'new']);
  });

  it.each([
    ['day/month-swapped date', { date: '2026-05-04' }, { date: '2026-04-05' }, ['date']],
    ['description that gained its wrapped line', { description: 'UPI-ZOMATO-123' }, { description: 'UPI-ZOMATO-123 CONTINUED' }, ['description']],
    ['reversal stored as a debit', { description: 'REVERSAL UPI-777', type: 'debit' }, { description: 'REVERSAL UPI-777', type: 'credit' }, ['type']],
    ['wrong last four digits', { description: 'CARD SPEND 1', account_last4: '4321' }, { description: 'CARD SPEND 1', account_last4: '9876' }, ['account']],
  ])('recognises a %s as the same transaction', async (_, stored, parsed, changes) => {
    const amount = 1000 + Math.floor(Math.random() * 1000);
    await call('POST', '/transactions/bulk', { token: u.token, body: [row({ amount, ...stored })] });
    const [r] = await reconcile(u.token, [row({ amount, ...parsed })]);
    expect(r!.status).toBe('changed');
    expect(r!.changes).toEqual(changes);
  });

  it('a corrected row is recognised as a duplicate on the next import', async () => {
    await call('POST', '/transactions/bulk', { token: u.token, body: [row({ amount: 777, date: '2026-05-04', description: 'SWAPPED ROW' })] });
    const [r] = await reconcile(u.token, [row({ amount: 777, date: '2026-04-05', description: 'SWAPPED ROW' })]);
    expect(r!.status).toBe('changed');
    const fixed = await call('PATCH', `/transactions/${r!.match!.id}`, { token: u.token, body: { date: '2026-04-05' } });
    expect(fixed.status).toBe(200);
    const [again] = await reconcile(u.token, [row({ amount: 777, date: '2026-04-05', description: 'SWAPPED ROW' })]);
    expect(again!.status).toBe('duplicate');
  });

  it('never matches against another user’s transactions', async () => {
    await call('POST', '/transactions/bulk', { token: other.token, body: [row({ amount: 4242, description: 'OTHER USER ROW' })] });
    const r = await reconcile(u.token, [row({ amount: 4242, description: 'OTHER USER ROW' }), row({ amount: 4242, description: 'OTHER USER ROW', date: '2026-05-04' })]);
    expect(r.map((x) => x.status)).toEqual(['new', 'new']);
  });

  it('validates its input', async () => {
    const bad = await call('POST', '/transactions/reconcile', { token: u.token, body: { rows: [row({ date: '2026-02-30' })] } });
    expect(bad.status).toBe(400);
    const empty = await call('POST', '/transactions/reconcile', { token: u.token, body: { rows: [] } });
    expect(empty.status).toBe(400);
  });
});
