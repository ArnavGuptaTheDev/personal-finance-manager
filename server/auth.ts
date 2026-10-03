import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, Role } from './env';
import { noteAudit } from './lib/audit';
import { base64url, randomToken, safeEqual, sha256, sha256Hex } from './lib/crypto';

// Cookies use the __Host- prefix: Secure, Path=/, no Domain → cannot be set by
// subdomains or read over plain HTTP. localhost counts as secure in browsers.
const SESSION_COOKIE = 'session';
const OAUTH_COOKIE = 'oauth';

const SESSION_TTL = 60 * 60 * 24 * 14; // 14 days
const SESSION_RENEW_BELOW = 60 * 60 * 24 * 7; // slide expiry when under 7 days left
const OAUTH_TTL = 60 * 10;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const now = () => Math.floor(Date.now() / 1000);

function appOrigin(c: Context<AppEnv>): string {
  return new URL(c.env.APP_URL).origin;
}

function redirectUri(c: Context<AppEnv>): string {
  // Built from configuration, never from the Host header.
  return `${appOrigin(c)}/api/auth/callback`;
}

function setSessionCookie(c: Context<AppEnv>, token: string, maxAge: number) {
  setCookie(c, SESSION_COOKIE, token, {
    prefix: 'host',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax', // Lax so the cookie survives the top-level redirect back from Google
    path: '/',
    maxAge,
  });
}

/** Only allow same-site relative paths as post-login destinations (no open redirects). */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/app/';
  return next;
}

type GoogleIdToken = {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

function decodeJwtPayload(jwt: string): GoogleIdToken | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    return JSON.parse(json) as GoogleIdToken;
  } catch {
    return null;
  }
}

function loginError(c: Context<AppEnv>, code: string, email?: string) {
  noteAudit(c, {
    outcome: code === 'not_allowed' ? 'denied' : 'failure',
    email,
    detail: { reason: code },
  });
  return c.redirect(`/login/?error=${encodeURIComponent(code)}`, 302);
}

export function ownerEmails(env: Env): string[] {
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Access is invite-only and fails closed:
 *  - emails in OWNER_EMAILS are owners,
 *  - emails with a row in access_grants are members,
 *  - everyone else is denied (including when OWNER_EMAILS is empty).
 */
export async function roleFor(env: Env, email: string): Promise<Role | null> {
  const normalized = email.toLowerCase();
  if (ownerEmails(env).includes(normalized)) return 'owner';
  const grant = await env.DB.prepare('SELECT 1 FROM access_grants WHERE email = ?').bind(normalized).first();
  return grant ? 'member' : null;
}

export const authRoutes = new Hono<AppEnv>();

// Step 1: send the browser to Google with state + PKCE + nonce.
authRoutes.get('/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return loginError(c, 'not_configured');

  // The OAuth cookie must be set on the same host Google redirects back to
  // (e.g. 127.0.0.1 vs localhost are different cookie jars), so hop to APP_URL first.
  const here = new URL(c.req.url);
  if (here.origin !== appOrigin(c)) return c.redirect(`${appOrigin(c)}${here.pathname}${here.search}`, 302);

  const state = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  const next = safeNext(c.req.query('next'));
  const challenge = base64url(await sha256(verifier));

  setCookie(c, OAUTH_COOKIE, [state, verifier, nonce, encodeURIComponent(next)].join('.'), {
    prefix: 'host',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_TTL,
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return c.redirect(url.toString(), 302);
});

// Step 2: Google redirects back here with ?code&state.
authRoutes.get('/callback', async (c) => {
  const stored = getCookie(c, OAUTH_COOKIE, 'host');
  deleteCookie(c, OAUTH_COOKIE, { prefix: 'host', path: '/', secure: true });

  if (c.req.query('error')) return loginError(c, 'cancelled');
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!stored) return loginError(c, 'missing_cookie');
  if (!code || !state) return loginError(c, 'invalid_request');

  const [storedState, verifier, nonce, ...rest] = stored.split('.');
  const nextEnc = rest.join('.');
  if (!storedState || !verifier || !nonce || !safeEqual(storedState, state)) {
    return loginError(c, 'invalid_state');
  }

  // Exchange the code server-to-server; the client secret never reaches the browser.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) {
    console.error('Google token exchange failed', tokenRes.status, await tokenRes.text());
    return loginError(c, 'token_exchange_failed');
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };

  // The ID token came directly from Google's token endpoint over TLS, so per
  // OpenID Connect Core §3.1.3.7 the claims can be validated without fetching JWKS.
  const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  if (
    !claims ||
    !GOOGLE_ISSUERS.includes(claims.iss) ||
    claims.aud !== c.env.GOOGLE_CLIENT_ID ||
    claims.exp < now() ||
    !claims.nonce ||
    !safeEqual(claims.nonce, nonce) ||
    !claims.sub ||
    !claims.email ||
    claims.email_verified !== true
  ) {
    return loginError(c, 'invalid_token');
  }

  const email = claims.email.toLowerCase();
  // Checked before any account row is created: uninvited people leave no data behind.
  const role = await roleFor(c.env, email);
  if (!role) return loginError(c, 'not_allowed', email);

  const user = await c.env.DB.prepare(
    `INSERT INTO users (google_sub, email, name, picture, last_login_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch())
     ON CONFLICT (google_sub) DO UPDATE SET
       email = excluded.email, name = excluded.name, picture = excluded.picture,
       last_login_at = unixepoch()
     RETURNING id`,
  )
    .bind(claims.sub, email, claims.name ?? null, claims.picture ?? null)
    .first<{ id: number }>();
  if (!user) return loginError(c, 'server_error', email);

  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
    c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(
      await sha256Hex(token),
      user.id,
      now() + SESSION_TTL,
    ),
  ]);
  setSessionCookie(c, token, SESSION_TTL);
  noteAudit(c, { userId: user.id, email, outcome: 'success', detail: { role } });

  return c.redirect(safeNext(nextEnc ? decodeURIComponent(nextEnc) : undefined), 302);
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE, 'host');
  if (token && token.length <= 100) {
    const id = await sha256Hex(token);
    const who = await c.env.DB.prepare(
      'SELECT s.user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
    )
      .bind(id)
      .first<{ user_id: number; email: string }>();
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    if (who) noteAudit(c, { userId: who.user_id, email: who.email });
  }
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
  return c.body(null, 204);
});

/**
 * Rejects requests without a valid session or whose user no longer has access.
 * Access is re-checked on every request, so revoking a grant (or removing an
 * owner from OWNER_EMAILS) takes effect immediately.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE, 'host');
  if (!token || token.length > 100) return c.json({ error: 'Not signed in' }, 401);

  const id = await sha256Hex(token);
  const session = await c.env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  )
    .bind(id)
    .first<{ user_id: number; expires_at: number; email: string }>();
  if (!session || session.expires_at < now()) {
    deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
    return c.json({ error: 'Session expired' }, 401);
  }

  const role = await roleFor(c.env, session.email);
  if (!role) {
    // Access was revoked: kill every session this user has.
    await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(session.user_id).run();
    deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
    noteAudit(c, { userId: session.user_id, email: session.email, action: 'auth.access_revoked_session' });
    return c.json({ error: 'Your access has been revoked' }, 401);
  }

  if (session.expires_at - now() < SESSION_RENEW_BELOW) {
    await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(now() + SESSION_TTL, id).run();
    setSessionCookie(c, token, SESSION_TTL);
  }

  c.set('userId', session.user_id);
  c.set('user', { id: session.user_id, email: session.email, role });
  await next();
};

/**
 * Who a request's session cookie belongs to, without authorising anything. Only used
 * to name the user in audit entries for requests rejected before requireAuth (CSRF).
 */
export async function sessionOwner(c: Context<AppEnv>): Promise<{ id: number; email: string } | null> {
  const token = getCookie(c, SESSION_COOKIE, 'host');
  if (!token || token.length > 100) return null;
  const row = await c.env.DB.prepare(
    'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at >= ?',
  )
    .bind(await sha256Hex(token), now())
    .first<{ id: number; email: string }>();
  return row ?? null;
}

/** Only owners (OWNER_EMAILS) get past this. Must run after requireAuth. */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user')?.role !== 'owner') return c.json({ error: 'Owner access required' }, 403);
  await next();
};
