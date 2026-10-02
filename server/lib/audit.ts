import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { AppEnv, AuditNote } from '../env';

// Stable action keys for every API route. The UI turns these into readable labels.
// Anything not listed is still logged, under its raw "METHOD /path" key.
const ACTIONS: Record<string, string> = {
  'GET /api/auth/google': 'auth.login_start',
  'GET /api/auth/callback': 'auth.login',
  'POST /api/auth/logout': 'auth.logout',

  'GET /api/me': 'account.view',
  'GET /api/me/export': 'account.export',
  'GET /api/me/activity': 'account.activity_view',
  'DELETE /api/me': 'account.delete',

  'GET /api/categories': 'category.list',
  'POST /api/categories': 'category.create',
  'PATCH /api/categories/:id': 'category.update',
  'DELETE /api/categories/:id': 'category.delete',
  'POST /api/categories/:id/keywords': 'category.rule_create',
  'DELETE /api/categories/keywords/:id': 'category.rule_delete',

  'GET /api/transactions': 'transaction.list',
  'POST /api/transactions': 'transaction.create',
  'POST /api/transactions/bulk': 'transaction.import',
  'POST /api/transactions/recategorize': 'transaction.recategorize',
  'PATCH /api/transactions/:id': 'transaction.update',
  'DELETE /api/transactions/:id': 'transaction.delete',

  'GET /api/summary': 'summary.view',

  'GET /api/budgets': 'budget.list',
  'PUT /api/budgets': 'budget.set',
  'DELETE /api/budgets/:id': 'budget.delete',

  'GET /api/people': 'person.list',
  'POST /api/people': 'person.create',
  'PUT /api/people/:id': 'person.update',
  'DELETE /api/people/:id': 'person.delete',

  'GET /api/loans': 'loan.list',
  'POST /api/loans': 'loan.create',
  'PUT /api/loans/:id': 'loan.update',
  'DELETE /api/loans/:id': 'loan.delete',
  'POST /api/loans/:id/payments': 'loan.payment_create',
  'DELETE /api/loans/:id/payments/:paymentId': 'loan.payment_delete',

  'GET /api/emis': 'emi.list',
  'POST /api/emis': 'emi.create',
  'PUT /api/emis/:id': 'emi.update',
  'DELETE /api/emis/:id': 'emi.delete',

  'GET /api/admin/users': 'admin.users_view',
  'POST /api/admin/access': 'admin.access_grant',
  'DELETE /api/admin/access/:email': 'admin.access_revoke',
  'DELETE /api/admin/users/:id': 'admin.user_delete',
  'GET /api/admin/audit': 'admin.audit_view',
};

/** Merge information into this request's audit entry (later calls win). */
export function noteAudit(c: Context<AppEnv>, note: AuditNote) {
  const prev = c.get('audit');
  c.set('audit', { ...prev, ...note, detail: { ...prev?.detail, ...note.detail } });
}

function outcomeFor(status: number): 'success' | 'failure' | 'denied' {
  if (status === 401 || status === 403) return 'denied';
  return status < 400 ? 'success' : 'failure';
}

const clip = (s: string | undefined | null, n: number) => (s ? s.slice(0, n) : null);

/**
 * Outermost middleware: writes one audit row for every API request after it
 * has been handled, including requests that failed or were rejected by CSRF,
 * auth or validation checks.
 */
export const auditTrail: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  const url = new URL(c.req.url);
  if (url.pathname === '/api/health') return;

  // The concrete endpoint that was targeted, even if a middleware (auth, owner
  // check, CSRF) rejected the request before it ran: denied attempts are named too.
  const endpoint = matchedRoutes(c).findLast((r) => !r.path.endsWith('*') && (r.method === c.req.method || r.method === 'ALL'));
  const pattern = endpoint?.path ?? null;
  const status = c.res.status;
  const note = c.get('audit') ?? {};
  const user = c.get('user');

  let action = note.action ?? (pattern ? ACTIONS[`${c.req.method} ${pattern}`] : undefined);
  if (!action) {
    if (status === 401) action = 'auth.unauthenticated';
    else if (status === 403) action = 'security.blocked';
    else if (status === 404) action = 'request.not_found';
    else action = `${c.req.method} ${pattern ?? url.pathname}`;
  }

  // Record which record was touched (numeric id from the URL), never request bodies
  // or query values, which can contain financial details. Query *names* are kept.
  const targetId = note.targetId ?? url.pathname.match(/\/(\d+)(?:\/[a-z]+)?$/)?.[1] ?? null;
  const queryKeys = [...new Set(url.searchParams.keys())].sort().join(',');
  const detail = { ...(queryKeys ? { query: queryKeys } : {}), ...note.detail };

  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (user_id, user_email, action, outcome, method, path, status, target_id, detail, ip, country, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        user?.id ?? note.userId ?? null,
        user?.email ?? note.email ?? null,
        action.slice(0, 80),
        note.outcome ?? outcomeFor(status),
        c.req.method,
        clip(url.pathname, 200),
        status,
        targetId === null ? null : String(targetId).slice(0, 254),
        Object.keys(detail).length ? JSON.stringify(detail).slice(0, 1000) : null,
        clip(c.req.header('cf-connecting-ip'), 64),
        clip(c.req.header('cf-ipcountry'), 8),
        clip(c.req.header('user-agent'), 300),
      )
      .run();
  } catch (err) {
    // Never break the user's request because logging failed, but make it visible.
    console.error('AUDIT WRITE FAILED', err);
  }
};
