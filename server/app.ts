import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes, requireAuth, sessionOwner } from './auth';
import type { AppEnv } from './env';
import { auditTrail, noteAudit } from './lib/audit';
import { adminRoutes } from './routes/admin';
import { categoryRoutes } from './routes/categories';
import { emiRoutes } from './routes/emis';
import { loanRoutes, peopleRoutes } from './routes/loans';
import { meRoutes } from './routes/me';
import { budgetRoutes, summaryRoutes } from './routes/summary';
import { transactionRoutes } from './routes/transactions';

const app = new Hono<AppEnv>().basePath('/api');

// Outermost: every request below (including rejected ones) leaves an audit row.
app.use(auditTrail);

app.use(
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    referrerPolicy: 'strict-origin-when-cross-origin',
    crossOriginResourcePolicy: 'same-origin',
    xFrameOptions: 'DENY',
  }),
);

// Financial data must never be cached by browsers or intermediaries.
app.use(async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// CSRF: state-changing requests must come from our own origin. Together with
// SameSite cookies and JSON-only bodies this blocks cross-site form posts.
app.use(async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const origin = c.req.header('origin');
  const allowed = [new URL(c.env.APP_URL).origin, c.env.DEV_ORIGIN].filter(Boolean);
  if (!origin || !allowed.includes(origin)) {
    const who = await sessionOwner(c);
    if (who) noteAudit(c, { userId: who.id, email: who.email });
    return c.json({ error: 'Cross-origin request blocked' }, 403);
  }
  return next();
});

app.use(
  bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/auth', authRoutes);

// Everything below requires a signed-in user.
app.use('*', requireAuth);
app.route('/me', meRoutes);
app.route('/categories', categoryRoutes);
app.route('/transactions', transactionRoutes);
app.route('/summary', summaryRoutes);
app.route('/budgets', budgetRoutes);
app.route('/people', peopleRoutes);
app.route('/loans', loanRoutes);
app.route('/emis', emiRoutes);
app.route('/admin', adminRoutes); // requireOwner inside

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  // Constraint violations from D1 (bad foreign key, duplicate name, ...) are client errors.
  const msg = err instanceof Error ? err.message : '';
  if (/UNIQUE constraint/i.test(msg)) return c.json({ error: 'That already exists' }, 409);
  if (/FOREIGN KEY|CHECK constraint/i.test(msg)) return c.json({ error: 'Invalid reference or value' }, 400);
  console.error(err);
  return c.json({ error: 'Internal server error' }, 500); // never leak internals
});

export default app;
