import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { notFound } from '../lib/validate';
import { auditQuery, queryAudit } from './admin';

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', async (c) => {
  const user = await c.env.DB.prepare('SELECT id, email, name, picture FROM users WHERE id = ?')
    .bind(c.get('userId'))
    .first();
  return user ? c.json({ ...user, role: c.get('user').role }) : notFound('User');
});

/** The signed-in user's own audit trail (always filtered to their own id). */
meRoutes.get('/activity', async (c) => {
  const parsed = auditQuery.pick({ before: true, limit: true }).safeParse(c.req.query());
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid filters' });
  return c.json(await queryAudit(c.env.DB, { ...parsed.data, user_id: c.get('userId') }));
});

/** Download everything stored about the current user as JSON. */
meRoutes.get('/export', async (c) => {
  const uid = c.get('userId');
  const q = (sql: string) => c.env.DB.prepare(sql).bind(uid);
  const [user, categories, keywords, transactions, budgets, people, loans, payments, emis] = await c.env.DB.batch([
    q('SELECT email, name, created_at FROM users WHERE id = ?'),
    q('SELECT id, name, kind FROM categories WHERE user_id = ?'),
    q('SELECT category_id, keyword, regex FROM category_keywords WHERE user_id = ?'),
    q(`SELECT date, amount_minor / 100.0 AS amount, type, description, category_id, bank, account_type,
              account_last4, remark FROM transactions WHERE user_id = ? ORDER BY date`),
    q('SELECT category_id, amount_minor / 100.0 AS amount FROM budgets WHERE user_id = ?'),
    q('SELECT id, name, note FROM people WHERE user_id = ?'),
    q('SELECT id, person_id, direction, title, amount_minor / 100.0 AS amount, date, note FROM loans WHERE user_id = ?'),
    q('SELECT loan_id, amount_minor / 100.0 AS amount, date, note FROM loan_payments WHERE user_id = ?'),
    q(`SELECT title, lender, installment_minor / 100.0 AS installment, frequency_unit, frequency_value,
              start_date, end_date, note FROM emis WHERE user_id = ?`),
  ]);
  c.header('Content-Disposition', 'attachment; filename="personal-finance-export.json"');
  return c.json({
    exported_at: new Date().toISOString(),
    user: user?.results[0] ?? null,
    categories: categories?.results,
    keywords: keywords?.results,
    transactions: transactions?.results,
    budgets: budgets?.results,
    people: people?.results,
    loans: loans?.results,
    loan_payments: payments?.results,
    emis: emis?.results,
  });
});

/** Permanently delete the account; ON DELETE CASCADE removes every owned row. */
meRoutes.delete('/', async (c) => {
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.get('userId')).run();
  deleteCookie(c, 'session', { prefix: 'host', path: '/', secure: true });
  return c.body(null, 204);
});
