import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, makeUser, txn } from './helpers';

// Every API route except /health and the OAuth endpoints. Keep in sync with server/app.ts:
// the "covers every registered route" test below fails when a route is added but not listed.
const PROTECTED: [string, string][] = [
  ['GET', '/me'], ['GET', '/me/export'], ['GET', '/me/activity'], ['DELETE', '/me'],
  ['GET', '/categories'], ['POST', '/categories'], ['PATCH', '/categories/1'], ['DELETE', '/categories/1'],
  ['POST', '/categories/1/keywords'], ['DELETE', '/categories/keywords/1'],
  ['GET', '/transactions'], ['POST', '/transactions'], ['POST', '/transactions/bulk'],
  ['POST', '/transactions/recategorize'], ['POST', '/transactions/reconcile'],
  ['PATCH', '/transactions/1'], ['DELETE', '/transactions/1'],
  ['GET', '/summary'], ['GET', '/budgets'], ['PUT', '/budgets'], ['DELETE', '/budgets/1'],
  ['GET', '/people'], ['POST', '/people'], ['PUT', '/people/1'], ['DELETE', '/people/1'],
  ['GET', '/loans'], ['POST', '/loans'], ['PUT', '/loans/1'], ['DELETE', '/loans/1'],
  ['POST', '/loans/1/payments'], ['DELETE', '/loans/1/payments/1'],
  ['GET', '/emis'], ['POST', '/emis'], ['PUT', '/emis/1'], ['DELETE', '/emis/1'],
  ['GET', '/admin/users'], ['POST', '/admin/access'], ['DELETE', '/admin/access/x%40test.com'],
  ['DELETE', '/admin/users/1'], ['GET', '/admin/audit'],
];
const ADMIN = PROTECTED.filter(([, p]) => p.startsWith('/admin'));

let owner: Awaited<ReturnType<typeof makeUser>>;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  owner = await makeUser('owner@test.com');
  alice = await makeUser('alice@test.com', { grant: true });
  bob = await makeUser('bob@test.com', { grant: true });
});

describe('authentication', () => {
  it('covers every registered route', async () => {
    const { default: app } = await import('../../server/app');
    const registered = new Set(
      app.routes
        .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
        .map((r) => `${r.method} ${r.path.replace(/^\/api/, '').replace(/:[a-zA-Z]+/g, ':p')}`),
    );
    const listed = new Set(PROTECTED.map(([m, p]) => `${m} ${p.replace(/\/(\d+|x%40test\.com)(?=\/|$)/g, '/:p')}`));
    const unlisted = [...registered].filter(
      (r) => !listed.has(r) && !['GET /health', 'GET /auth/google', 'GET /auth/callback', 'POST /auth/logout'].includes(r),
    );
    expect(unlisted).toEqual([]);
  });

  it.each(PROTECTED)('%s %s requires a session', async (method, path) => {
    const res = await call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    expect(res.status).toBe(401);
  });

  it('rejects unknown, malformed and expired session tokens', async () => {
    expect((await call('GET', '/me', { token: 'not-a-real-token' })).status).toBe(401);
    expect((await call('GET', '/me', { token: 'x'.repeat(500) })).status).toBe(401);
    const u = await makeUser('expired@test.com', { grant: true });
    await env.DB.prepare('UPDATE sessions SET expires_at = unixepoch() - 1 WHERE user_id = ?').bind(u.id).run();
    expect((await call('GET', '/me', { token: u.token })).status).toBe(401);
  });

  it('denies a signed-in user who was never invited, and purges their sessions', async () => {
    const eve = await makeUser('eve@test.com');
    const res = await call('GET', '/me', { token: eve.token });
    expect(res.status).toBe(401);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(eve.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe('roles', () => {
  it('owners come only from OWNER_EMAILS', async () => {
    expect((await call('GET', '/me', { token: owner.token })).json.role).toBe('owner');
    const second = await makeUser('second-owner@test.com');
    expect((await call('GET', '/me', { token: second.token })).json.role).toBe('owner');
    expect((await call('GET', '/me', { token: alice.token })).json.role).toBe('member');
  });

  it.each(ADMIN)('members get 403 on %s %s', async (method, path) => {
    const res = await call(method, path, { token: alice.token, body: method === 'POST' ? { email: 'z@test.com' } : undefined });
    expect(res.status).toBe(403);
  });

  it('owners cannot revoke or delete other owners', async () => {
    const o2 = await makeUser('second-owner-b@test.com');
    expect((await call('DELETE', '/admin/access/second-owner%40test.com', { token: owner.token })).status).toBe(400);
    expect((await call('DELETE', `/admin/users/${owner.id}`, { token: owner.token })).status).toBe(400);
    expect(o2.id).toBeGreaterThan(0);
  });

  it('revoking access signs the member out immediately', async () => {
    const carol = await makeUser('carol@test.com', { grant: true });
    expect((await call('GET', '/me', { token: carol.token })).status).toBe(200);
    expect((await call('DELETE', '/admin/access/carol%40test.com', { token: owner.token })).status).toBe(204);
    expect((await call('GET', '/me', { token: carol.token })).status).toBe(401);
  });
});

describe('CSRF and request format', () => {
  it('blocks state-changing requests without our Origin', async () => {
    expect((await call('POST', '/people', { token: alice.token, body: { name: 'x' }, origin: null })).status).toBe(403);
    expect((await call('POST', '/people', { token: alice.token, body: { name: 'x' }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/people', { token: alice.token, body: { name: 'x' } })).status).toBe(201);
  });

  it('accepts JSON bodies only', async () => {
    const res = await call('POST', '/people', { token: alice.token, body: 'name=x', contentType: 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(415);
  });

  it('rejects oversized bodies', async () => {
    const res = await call('POST', '/people', { token: alice.token, body: { name: 'x'.repeat(3 * 1024 * 1024) } });
    expect(res.status).toBe(413);
  });

  it('sends security headers and no-store on API responses', async () => {
    const res = await call('GET', '/me', { token: alice.token });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('input validation', () => {
  it.each([
    ['impossible date', { date: '2026-02-30' }],
    ['bad date format', { date: '10/09/2026' }],
    ['3 decimals', { amount: 1.234 }],
    ['negative amount', { amount: -5 }],
    ['zero amount', { amount: 0 }],
    ['bad type', { type: 'refund' }],
    ['empty description', { description: '   ' }],
    ['huge description', { description: 'x'.repeat(501) }],
  ])('rejects %s', async (_, over) => {
    expect((await call('POST', '/transactions', { token: alice.token, body: txn(over) })).status).toBe(400);
  });

  it('treats search input literally (no SQL injection, no LIKE wildcards)', async () => {
    await call('POST', '/transactions', { token: bob.token, body: txn({ description: 'plain text' }) });
    for (const q of ["' OR 1=1--", '%', '_']) {
      const res = await call('GET', `/transactions?q=${encodeURIComponent(q)}`, { token: bob.token });
      expect(res.status).toBe(200);
      expect(res.json.total).toBe(0);
    }
  });
});

describe('per-user data isolation', () => {
  type Created = Record<string, number>;
  let a: Created;

  beforeAll(async () => {
    const t = await call('POST', '/transactions', { token: alice.token, body: txn({ description: 'ALICE SECRET', amount: 4321.09 }) });
    const cat = await call('POST', '/categories', { token: alice.token, body: { name: 'Alice Only' } });
    const kw = await call('POST', `/categories/${cat.json.id}/keywords`, { token: alice.token, body: { keyword: 'aliceword' } });
    const bud = await call('PUT', '/budgets', { token: alice.token, body: { category_id: 1, amount: 999 } });
    const person = await call('POST', '/people', { token: alice.token, body: { name: 'Alice Friend' } });
    const loan = await call('POST', '/loans', {
      token: alice.token,
      body: { person_id: person.json.id, direction: 'lent', title: 'Loan', amount: 100, date: '2026-09-01' },
    });
    const pay = await call('POST', `/loans/${loan.json.id}/payments`, { token: alice.token, body: { amount: 10, date: '2026-09-02' } });
    const emi = await call('POST', '/emis', {
      token: alice.token,
      body: { title: 'Car', installment: 100, frequency_unit: 'months', start_date: '2026-01-01', end_date: '2026-12-01' },
    });
    a = { txn: t.json.id, cat: cat.json.id, kw: kw.json.id, bud: bud.json.id, person: person.json.id, loan: loan.json.id, pay: pay.json.id, emi: emi.json.id };
    for (const id of Object.values(a)) expect(id).toBeGreaterThan(0);
  });

  it.each(['bob', 'owner'] as const)('%s cannot see Alice’s records in any list', async (who) => {
    const token = (who === 'bob' ? bob : owner).token;
    const tx = await call('GET', '/transactions?limit=200', { token });
    expect(tx.json.items.some((t: { description: string }) => t.description === 'ALICE SECRET')).toBe(false);
    expect((await call('GET', '/categories', { token })).json.some((c: { id: number }) => c.id === a.cat)).toBe(false);
    expect((await call('GET', '/people', { token })).json.some((p: { id: number }) => p.id === a.person)).toBe(false);
    expect((await call('GET', '/loans', { token })).json.some((l: { id: number }) => l.id === a.loan)).toBe(false);
    expect((await call('GET', '/emis', { token })).json.some((e: { id: number }) => e.id === a.emi)).toBe(false);
    expect((await call('GET', '/budgets', { token })).json.items.some((b: { id: number }) => b.id === a.bud)).toBe(false);
    expect((await call('GET', '/summary', { token })).json.spend).not.toBe(4321.09);
    const exp = await call('GET', '/me/export', { token });
    expect(JSON.stringify(exp.json)).not.toContain('ALICE SECRET');
  });

  it.each(['bob', 'owner'] as const)('%s cannot change or delete Alice’s records', async (who) => {
    const token = (who === 'bob' ? bob : owner).token;
    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/transactions/${a.txn}`, { remark: 'x' }],
      ['DELETE', `/transactions/${a.txn}`],
      ['PATCH', `/categories/${a.cat}`, { name: 'Hacked' }],
      ['DELETE', `/categories/${a.cat}`],
      ['DELETE', `/categories/keywords/${a.kw}`],
      ['DELETE', `/budgets/${a.bud}`],
      ['PUT', `/people/${a.person}`, { name: 'Hacked' }],
      ['DELETE', `/people/${a.person}`],
      ['PUT', `/loans/${a.loan}`, { person_id: a.person, direction: 'lent', title: 'x', amount: 1, date: '2026-09-01' }],
      ['DELETE', `/loans/${a.loan}`],
      ['DELETE', `/loans/${a.loan}/payments/${a.pay}`],
      ['PUT', `/emis/${a.emi}`, { title: 'x', installment: 1, frequency_unit: 'months', start_date: '2026-01-01', end_date: '2026-02-01' }],
      ['DELETE', `/emis/${a.emi}`],
    ];
    for (const [m, p, body] of attempts) {
      const res = await call(m, p, { token, body });
      expect([400, 404], `${m} ${p}`).toContain(res.status);
    }
    const still = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM transactions WHERE id = ?1 AND remark IS NULL) + (SELECT COUNT(*) FROM categories WHERE id = ?2 AND name = 'Alice Only')
            + (SELECT COUNT(*) FROM people WHERE id = ?3 AND name = 'Alice Friend') + (SELECT COUNT(*) FROM loans WHERE id = ?4)
            + (SELECT COUNT(*) FROM loan_payments WHERE id = ?5) + (SELECT COUNT(*) FROM emis WHERE id = ?6 AND title = 'Car')
            + (SELECT COUNT(*) FROM budgets WHERE id = ?7) + (SELECT COUNT(*) FROM category_keywords WHERE id = ?8) AS n`,
    )
      .bind(a.txn, a.cat, a.person, a.loan, a.pay, a.emi, a.bud, a.kw)
      .first<{ n: number }>();
    expect(still?.n).toBe(8);
  });

  it('Bob cannot reference Alice’s category, person or loan', async () => {
    expect((await call('POST', '/transactions', { token: bob.token, body: txn({ category_id: a.cat }) })).status).toBe(400);
    expect((await call('PUT', '/budgets', { token: bob.token, body: { category_id: a.cat, amount: 5 } })).status).toBe(400);
    expect((await call('POST', `/categories/${a.cat}/keywords`, { token: bob.token, body: { keyword: 'mine' } })).status).toBe(404);
    expect(
      (await call('POST', '/loans', { token: bob.token, body: { person_id: a.person, direction: 'lent', title: 'x', amount: 1, date: '2026-09-01' } })).status,
    ).toBe(400);
    expect((await call('POST', `/loans/${a.loan}/payments`, { token: bob.token, body: { amount: 1, date: '2026-09-01' } })).status).toBe(400);
    const bulk = await call('POST', '/transactions/bulk', { token: bob.token, body: [txn({ category_id: a.cat, description: 'bulk ref' })] });
    expect(bulk.status).toBe(200);
    const row = await env.DB.prepare("SELECT category_id FROM transactions WHERE user_id = ? AND description = 'bulk ref'").bind(bob.id).first();
    expect(row?.category_id).toBeNull();
    const rec = await call('POST', '/transactions/recategorize', { token: bob.token, body: { ids: [a.txn], category_id: 1 } });
    expect(rec.json.updated).toBe(0);
  });

  it('built-in categories are read-only for everyone', async () => {
    expect((await call('PATCH', '/categories/1', { token: owner.token, body: { name: 'Mine' } })).status).toBe(404);
    expect((await call('DELETE', '/categories/1', { token: owner.token })).status).toBe(404);
  });
});

describe('admin views never expose financial data', () => {
  it('users list and audit log contain no amounts or descriptions', async () => {
    await call('POST', '/transactions', { token: alice.token, body: txn({ description: 'VERY PRIVATE MERCHANT', amount: 7777.77 }) });
    const users = JSON.stringify((await call('GET', '/admin/users', { token: owner.token })).json);
    const audit = JSON.stringify((await call('GET', '/admin/audit?limit=200', { token: owner.token })).json);
    for (const s of [users, audit]) {
      expect(s).not.toContain('VERY PRIVATE MERCHANT');
      expect(s).not.toContain('7777');
    }
  });
});

describe('audit log', () => {
  it('is append-only at the database level', async () => {
    await call('GET', '/me', { token: alice.token });
    await expect(env.DB.prepare('UPDATE audit_logs SET action = ?').bind('x').run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM audit_logs').run()).rejects.toThrow(/append-only/);
  });

  it('records denied attempts under the action that was attempted', async () => {
    await call('POST', '/admin/access', { token: alice.token, body: { email: 'z@test.com' } });
    const row = await env.DB.prepare(
      "SELECT action, outcome FROM audit_logs WHERE user_id = ? AND path = '/api/admin/access' ORDER BY id DESC LIMIT 1",
    )
      .bind(alice.id)
      .first();
    expect(row).toEqual({ action: 'admin.access_grant', outcome: 'denied' });
  });

  it('never stores search terms', async () => {
    await call('GET', '/transactions?q=topsecretsearch', { token: alice.token });
    const hit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE detail LIKE '%topsecretsearch%' OR path LIKE '%topsecretsearch%'").first<{ n: number }>();
    expect(hit?.n).toBe(0);
  });

  it('a member’s activity feed only ever shows their own entries', async () => {
    const res = await call('GET', `/me/activity?user_id=${owner.id}&limit=200`, { token: alice.token });
    expect(res.json.items.every((e: { user_id: number }) => e.user_id === alice.id)).toBe(true);
  });
});
