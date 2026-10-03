import { env, exports } from 'cloudflare:workers';

export const ORIGIN = 'https://app.test';

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Creates a user with a live session and returns its id and session token. */
export async function makeUser(email: string, opts: { grant?: boolean } = {}) {
  const user = await env.DB.prepare(
    'INSERT INTO users (google_sub, email, name) VALUES (?, ?, ?) RETURNING id',
  )
    .bind(`sub-${email}`, email, email.split('@')[0])
    .first<{ id: number }>();
  if (opts.grant) {
    await env.DB.prepare('INSERT INTO access_grants (email, granted_by, granted_by_email) VALUES (?, 1, ?)')
      .bind(email, 'owner@test.com')
      .run();
  }
  const token = `tok-${email}-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, unixepoch() + 3600)')
    .bind(await sha256Hex(token), user!.id)
    .run();
  return { id: user!.id, email, token };
}

type Opts = { token?: string; body?: unknown; origin?: string | null; contentType?: string | null };

/** Sends a request through the real Worker entry point. */
export async function call(method: string, path: string, opts: Opts = {}) {
  const headers = new Headers();
  if (opts.token) headers.set('cookie', `__Host-session=${opts.token}`);
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin && method !== 'GET') headers.set('origin', origin);
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const ct = opts.contentType === undefined ? 'application/json' : opts.contentType;
    if (ct) headers.set('content-type', ct);
  }
  const res = await exports.default.fetch(new Request(`${ORIGIN}/api${path}`, { method, headers, body, redirect: 'manual' }));
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as any, headers: res.headers };
}

export const txn = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-10',
  amount: 250.5,
  type: 'debit',
  description: 'UPI-SWIGGY-123',
  ...over,
});
