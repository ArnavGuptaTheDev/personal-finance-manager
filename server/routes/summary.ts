import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { fromMinor, toMinor } from '../lib/money';
import { restore, softDelete } from '../lib/soft-delete';
import { idParam, isoDate, money, notFound, readJson } from '../lib/validate';
import { allowedCategoryIds } from './categories';

// Transactions in 'transfer' categories (card bill payments, investments, moving
// money between own accounts) and confirmed transfer pairs are excluded from
// income/spend so nothing is double counted.
const NOT_TRANSFER = `((c.kind IS NULL OR c.kind <> 'transfer') AND t.transfer_pair_id IS NULL)`;

export const summaryRoutes = new Hono<AppEnv>();

summaryRoutes.get('/', async (c) => {
  const parsed = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(c.req.query());
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid date range' });
  const from = parsed.data.from ?? '0000-01-01';
  const to = parsed.data.to ?? '9999-12-31';
  const uid = c.get('userId');
  const base = `FROM transactions t LEFT JOIN categories c ON c.id = t.category_id AND c.deleted_at IS NULL
                WHERE t.user_id = ?1 AND t.deleted_at IS NULL AND t.date BETWEEN ?2 AND ?3`;
  const db = c.env.DB;

  type Totals = { income: number; spend: number; count: number; uncategorized: number };
  type Month = { month: string; income: number; spend: number };
  type ByCat = { category_id: number | null; name: string | null; spend: number; count: number };

  const [totals, months, byCategory] = await db.batch<Totals | Month | ByCat>([
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.type = 'credit' AND ${NOT_TRANSFER} THEN t.amount_minor END), 0) AS income,
              COALESCE(SUM(CASE WHEN t.type = 'debit'  AND ${NOT_TRANSFER} THEN t.amount_minor END), 0) AS spend,
              COUNT(*) AS count,
              SUM(t.type = 'debit' AND c.id IS NULL) AS uncategorized ${base}`,
    ).bind(uid, from, to),
    db.prepare(
      `SELECT substr(t.date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN t.type = 'credit' AND ${NOT_TRANSFER} THEN t.amount_minor END), 0) AS income,
              COALESCE(SUM(CASE WHEN t.type = 'debit'  AND ${NOT_TRANSFER} THEN t.amount_minor END), 0) AS spend
         ${base} GROUP BY month ORDER BY month`,
    ).bind(uid, from, to),
    db.prepare(
      `SELECT c.id AS category_id, c.name, SUM(t.amount_minor) AS spend, COUNT(*) AS count
         ${base} AND t.type = 'debit' AND ${NOT_TRANSFER}
        GROUP BY c.id ORDER BY spend DESC`,
    ).bind(uid, from, to),
  ]);

  const t = (totals?.results[0] ?? { income: 0, spend: 0, count: 0, uncategorized: 0 }) as Totals;
  return c.json({
    income: fromMinor(t.income),
    spend: fromMinor(t.spend),
    net: fromMinor(t.income - t.spend),
    count: t.count,
    uncategorized: t.uncategorized ?? 0,
    months: ((months?.results ?? []) as Month[]).map((m) => ({
      month: m.month,
      income: fromMinor(m.income),
      spend: fromMinor(m.spend),
    })),
    by_category: ((byCategory?.results ?? []) as ByCat[]).map((r) => ({
      category_id: r.category_id,
      name: r.name ?? 'Uncategorized',
      spend: fromMinor(r.spend),
      count: r.count,
    })),
  });
});

export const budgetRoutes = new Hono<AppEnv>();

/**
 * Monthly budgets with what has been spent against each in the given month: debits
 * minus refunds (credits) in the category, never below zero. The client sends the
 * month from its own calendar; the server's UTC date is only a fallback.
 */
budgetRoutes.get('/', async (c) => {
  const month = c.req.query('month') ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HTTPException(400, { message: 'month must be YYYY-MM' });
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.category_id, c.name, b.amount_minor,
            MAX(0, COALESCE((SELECT SUM(CASE WHEN t.type = 'debit' THEN t.amount_minor ELSE -t.amount_minor END) FROM transactions t
                       WHERE t.user_id = b.user_id AND t.category_id = b.category_id AND t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
                         AND substr(t.date, 1, 7) = ?2), 0)) AS spent_minor
       FROM budgets b JOIN categories c ON c.id = b.category_id AND c.deleted_at IS NULL
      WHERE b.user_id = ?1 AND b.deleted_at IS NULL ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(c.get('userId'), month)
    .all<{ id: number; category_id: number; name: string; amount_minor: number; spent_minor: number }>();
  return c.json({
    month,
    items: results.map((r) => ({
      id: r.id,
      category_id: r.category_id,
      name: r.name,
      amount: fromMinor(r.amount_minor),
      spent: fromMinor(r.spent_minor),
    })),
  });
});

/** Create or update the budget for a category. */
budgetRoutes.put('/', async (c) => {
  const uid = c.get('userId');
  const body = await readJson(c, z.object({ category_id: z.number().int().positive(), amount: money }));
  if (!(await allowedCategoryIds(c.env.DB, uid)).has(body.category_id)) {
    throw new HTTPException(400, { message: 'Unknown category' });
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO budgets (user_id, category_id, amount_minor) VALUES (?, ?, ?)
     ON CONFLICT (user_id, category_id) DO UPDATE SET amount_minor = excluded.amount_minor, deleted_at = NULL
     RETURNING id, category_id, amount_minor`,
  )
    .bind(uid, body.category_id, toMinor(body.amount))
    .first<{ id: number; category_id: number; amount_minor: number }>();
  return c.json(row && { id: row.id, category_id: row.category_id, amount: fromMinor(row.amount_minor) });
});

budgetRoutes.delete('/:id', async (c) => {
  return (await softDelete(c.env.DB, 'budgets', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Budget');
});

budgetRoutes.post('/:id/restore', async (c) => {
  return (await restore(c.env.DB, 'budgets', idParam(c), c.get('userId'))) ? c.json({ ok: true }) : notFound('Deleted budget');
});
