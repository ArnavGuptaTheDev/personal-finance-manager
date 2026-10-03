import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.test';
const realFetch = globalThis.fetch;

function b64url(obj: unknown) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function start(next = '/app/budgets/') {
  const res = await exports.default.fetch(new Request(`${ORIGIN}/api/auth/google?next=${encodeURIComponent(next)}`, { redirect: 'manual' }));
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const loc = new URL(res.headers.get('location')!);
  return { res, cookie, state: loc.searchParams.get('state')!, nonce: loc.searchParams.get('nonce')!, loc };
}

function mockGoogle(claims: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ id_token: `h.${b64url(claims)}.s` });
    }
    return realFetch(input, init);
  });
}

async function callback(cookie: string, state: string) {
  const res = await exports.default.fetch(
    new Request(`${ORIGIN}/api/auth/callback?code=abc&state=${state}`, { headers: { cookie }, redirect: 'manual' }),
  );
  return { status: res.status, location: res.headers.get('location') ?? '', setCookie: res.headers.get('set-cookie') ?? '' };
}

const good = (nonce: string, email: string) => ({
  iss: 'https://accounts.google.com',
  aud: 'test-client-id',
  sub: `google-${email}`,
  exp: Math.floor(Date.now() / 1000) + 600,
  nonce,
  email,
  email_verified: true,
  name: 'Test',
});

afterEach(() => vi.restoreAllMocks());

describe('Google sign-in', () => {
  it('starts with PKCE, state and nonce, in a __Host- cookie', async () => {
    const { res, cookie, loc } = await start();
    expect(res.status).toBe(302);
    expect(loc.origin).toBe('https://accounts.google.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback`);
    expect(cookie.startsWith('__Host-oauth=')).toBe(true);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
  });

  it('rejects a callback without the sign-in cookie or with a wrong state', async () => {
    expect((await callback('', 'x')).location).toContain('error=missing_cookie');
    const { cookie } = await start();
    expect((await callback(cookie, 'wrong-state')).location).toContain('error=invalid_state');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired token', { exp: 1 }],
    ['unverified email', { email_verified: false }],
    ['wrong nonce', { nonce: 'not-the-nonce' }],
  ])('rejects an ID token with %s', async (_, override) => {
    const { cookie, state, nonce } = await start();
    mockGoogle({ ...good(nonce, 'owner@test.com'), ...override });
    expect((await callback(cookie, state)).location).toContain('error=invalid_token');
  });

  it('refuses uninvited people without creating an account', async () => {
    const { cookie, state, nonce } = await start();
    mockGoogle(good(nonce, 'stranger@test.com'));
    const res = await callback(cookie, state);
    expect(res.location).toContain('error=not_allowed');
    expect(res.setCookie).not.toContain('__Host-session=');
    const row = await env.DB.prepare("SELECT 1 FROM users WHERE email = 'stranger@test.com'").first();
    expect(row).toBeNull();
  });

  it('signs in an owner and returns to a safe local path only', async () => {
    const { cookie, state, nonce } = await start('//evil.example/x');
    mockGoogle(good(nonce, 'owner@test.com'));
    const res = await callback(cookie, state);
    expect(res.location).toBe('/app/');
    expect(res.setCookie).toMatch(/__Host-session=[^;]+;.*HttpOnly/i);
    const stored = await env.DB.prepare(
      "SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'owner@test.com'",
    ).first<{ id: string }>();
    const token = res.setCookie.match(/__Host-session=([^;]+)/)![1]!;
    expect(stored?.id).not.toBe(token);
    expect(stored?.id).toMatch(/^[0-9a-f]{64}$/);
  });
});
