// Owner-only administration: who may use the app, and the audit trail.
// Deliberately exposes NO financial data. Owners can see who did what and when,
// never another user's transactions, amounts, budgets, loans or EMIs.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ownerEmails, requireOwner } from '../auth';
import type { AppEnv } from '../env';
import { noteAudit } from '../lib/audit';
import { idParam, notFound, optionalText, readJson } from '../lib/validate';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireOwner);

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

type UserRow = { id: number; email: string; name: string | null; created_at: number; last_login_at: number | null; sessions: number };
type GrantRow = { email: string; granted_by_email: string; note: string | null; created_at: number };

/** Everyone who is, was, or may become a user, with their access status. */
adminRoutes.get('/users', async (c) => {
  const [users, grants] = await c.env.DB.batch<UserRow | GrantRow>([
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > unixepoch()) AS sessions
         FROM users u`,
    ),
    c.env.DB.prepare('SELECT email, granted_by_email, note, created_at FROM access_grants'),
  ]);
  const owners = ownerEmails(c.env);
  const byEmail = new Map(((users?.results ?? []) as UserRow[]).map((u) => [u.email, u]));
  const grantMap = new Map(((grants?.results ?? []) as GrantRow[]).map((g) => [g.email, g]));
  const emails = new Set([...owners, ...grantMap.keys(), ...byEmail.keys()]);

  const rows = [...emails].map((email) => {
    const u = byEmail.get(email);
    const g = grantMap.get(email);
    const role = owners.includes(email) ? 'owner' : g ? 'member' : null;
    return {
      email,
      role,
      // invited = allowed but never signed in; revoked = has an account but no access
      status: role ? (u ? 'active' : 'invited') : 'revoked',
      user_id: u?.id ?? null,
      name: u?.name ?? null,
      joined_at: u?.created_at ?? null,
      last_login_at: u?.last_login_at ?? null,
      active_sessions: u?.sessions ?? 0,
      granted_by: g?.granted_by_email ?? (role === 'owner' ? 'OWNER_EMAILS' : null),
      granted_at: g?.created_at ?? null,
      note: g?.note ?? null,
    };
  });
  rows.sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || a.email.localeCompare(b.email));
  return c.json(rows);
});

/** Allow an email address to sign in. */
adminRoutes.post('/access', async (c) => {
  const body = await readJson(c, z.object({ email: emailSchema, note: optionalText(200) }));
  noteAudit(c, { targetId: body.email });
  if (ownerEmails(c.env).includes(body.email)) {
    throw new HTTPException(409, { message: 'That address is an owner and already has access' });
  }
  const me = c.get('user');
  const res = await c.env.DB.prepare(
    `INSERT INTO access_grants (email, granted_by, granted_by_email, note) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  )
    .bind(body.email, me.id, me.email, body.note)
    .run();
  if (!res.meta.changes) throw new HTTPException(409, { message: 'That address already has access' });
  return c.json({ email: body.email }, 201);
});

/** Revoke access. Signs the user out everywhere immediately; their data is kept. */
adminRoutes.delete('/access/:email', async (c) => {
  const parsed = emailSchema.safeParse(decodeURIComponent(c.req.param('email')));
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid email' });
  const email = parsed.data;
  noteAudit(c, { targetId: email });
  if (ownerEmails(c.env).includes(email)) {
    throw new HTTPException(400, { message: 'Owners are managed in OWNER_EMAILS, not here' });
  }
  const [del] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM access_grants WHERE email = ?').bind(email),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)').bind(email),
  ]);
  if (!del?.meta.changes) notFound('Access grant');
  return c.body(null, 204);
});

/** Permanently delete a non-owner account and all of its data (and its access). */
adminRoutes.delete('/users/:id', async (c) => {
  const id = idParam(c);
  const target = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string }>();
  if (!target) notFound('User');
  noteAudit(c, { detail: { target_email: target.email } });
  if (ownerEmails(c.env).includes(target.email)) {
    throw new HTTPException(400, { message: 'Owner accounts cannot be deleted here' });
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM access_grants WHERE email = ?').bind(target.email),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id), // cascades to all owned rows
  ]);
  return c.body(null, 204);
});

// ------------------------------------------------------------ audit log ----

export const auditQuery = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  email: z.string().trim().toLowerCase().max(254).optional(),
  action: z.string().trim().max(80).regex(/^[a-z_.]*$/).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: z.coerce.number().int().min(0).optional(), // unix seconds
  to: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().positive().optional(), // id cursor for "load more"
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type AuditFilters = z.infer<typeof auditQuery>;

export async function queryAudit(db: D1Database, f: AuditFilters) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.user_id) (where.push('user_id = ?'), args.push(f.user_id));
  if (f.email) (where.push('user_email = ?'), args.push(f.email));
  if (f.action) (where.push('action LIKE ?'), args.push(`${f.action}%`));
  if (f.outcome) (where.push('outcome = ?'), args.push(f.outcome));
  if (f.from) (where.push('created_at >= ?'), args.push(f.from));
  if (f.to) (where.push('created_at <= ?'), args.push(f.to));
  if (f.before) (where.push('id < ?'), args.push(f.before));
  const sql = `SELECT id, created_at, user_id, user_email, action, outcome, method, path, status, target_id, detail, ip, country, user_agent
                 FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, f.limit + 1).all<Record<string, unknown> & { id: number; detail: string | null }>();
  const items = results.slice(0, f.limit).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  return { items, next_before: results.length > f.limit ? items.at(-1)?.id ?? null : null };
}

adminRoutes.get('/audit', async (c) => {
  const parsed = auditQuery.safeParse(c.req.query());
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid filters' });
  return c.json(await queryAudit(c.env.DB, parsed.data));
});
