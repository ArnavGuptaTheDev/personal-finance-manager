import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { noteAudit } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { fromMinor, toMinor } from '../lib/money';
import { idParam, isoDate, money, notFound, optionalText, readJson } from '../lib/validate';
import { allowedCategoryIds } from './categories';

export const transactionRoutes = new Hono<AppEnv>();

const MAX_BULK = 3000;
const INSERT_CHUNK = 50;

const transactionInput = z.object({
  date: isoDate,
  amount: money,
  type: z.enum(['debit', 'credit']),
  description: z.string().trim().min(1).max(500),
  category_id: z.number().int().positive().nullish(),
  bank: optionalText(40),
  account_type: z.enum(['savings', 'credit_card', 'cash', 'other']).nullish(),
  account_last4: z.string().regex(/^\d{4}$/).nullish(),
  remark: optionalText(500),
});
type TransactionInput = z.infer<typeof transactionInput>;

const transactionPatch = z.object({
  date: isoDate.optional(),
  amount: money.optional(),
  type: z.enum(['debit', 'credit']).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  category_id: z.number().int().positive().nullable().optional(),
  remark: optionalText(500).optional(),
});

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  type: z.enum(['debit', 'credit']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

type TxnRow = {
  id: number;
  date: string;
  amount_minor: number;
  type: string;
  description: string;
  category_id: number | null;
  category_name: string | null;
  bank: string | null;
  account_type: string | null;
  account_last4: string | null;
  remark: string | null;
};

const toApi = ({ amount_minor, ...rest }: TxnRow) => ({ ...rest, amount: fromMinor(amount_minor) });

const SELECT_TXN = `SELECT t.id, t.date, t.amount_minor, t.type, t.description, t.category_id, c.name AS category_name,
                           t.bank, t.account_type, t.account_last4, t.remark
                      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id`;

transactionRoutes.get('/', async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid filters' });
  const f = parsed.data;

  const where = ['t.user_id = ?'];
  const args: (string | number)[] = [c.get('userId')];
  if (f.from) (where.push('t.date >= ?'), args.push(f.from));
  if (f.to) (where.push('t.date <= ?'), args.push(f.to));
  if (f.type) (where.push('t.type = ?'), args.push(f.type));
  if (f.category === 'none') where.push('t.category_id IS NULL');
  else if (f.category) (where.push('t.category_id = ?'), args.push(f.category));
  if (f.q) {
    // Escape LIKE wildcards so user input is matched literally.
    where.push("(t.description LIKE ? ESCAPE '\\' OR t.remark LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(like, like);
  }
  const whereSql = where.join(' AND ');

  const [rows, count] = await c.env.DB.batch<TxnRow | { total: number }>([
    c.env.DB.prepare(`${SELECT_TXN} WHERE ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).bind(
      ...args,
      f.limit,
      f.offset,
    ),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM transactions t WHERE ${whereSql}`).bind(...args),
  ]);
  return c.json({
    items: ((rows?.results ?? []) as TxnRow[]).map(toApi),
    total: ((count?.results[0] as { total: number } | undefined)?.total ?? 0),
  });
});

async function assertCategory(db: D1Database, uid: number, id: number | null | undefined) {
  if (id == null) return;
  if (!(await allowedCategoryIds(db, uid)).has(id)) throw new HTTPException(400, { message: 'Unknown category' });
}

function insertStmt(db: D1Database, uid: number, t: TransactionInput, dedupeKey: string | null) {
  return db
    .prepare(
      `INSERT INTO transactions (user_id, date, amount_minor, type, description, category_id, bank, account_type,
                                 account_last4, remark, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      uid,
      t.date,
      toMinor(t.amount),
      t.type,
      t.description,
      t.category_id ?? null,
      t.bank ?? null,
      t.account_type ?? null,
      t.account_last4 ?? null,
      t.remark ?? null,
      dedupeKey,
    );
}

transactionRoutes.post('/', async (c) => {
  const uid = c.get('userId');
  const body = await readJson(c, transactionInput);
  await assertCategory(c.env.DB, uid, body.category_id);
  const res = await insertStmt(c.env.DB, uid, body, null).run();
  const row = await c.env.DB.prepare(`${SELECT_TXN} WHERE t.id = ? AND t.user_id = ?`)
    .bind(res.meta.last_row_id, uid)
    .first<TxnRow>();
  return c.json(row ? toApi(row) : null, 201);
});

/**
 * Import parsed statement rows. Each row gets a deterministic dedupe key so that
 * importing an overlapping statement again only adds the new transactions.
 * Identical rows inside one statement (two ₹20 teas on the same day) are kept
 * apart by their occurrence index.
 */
transactionRoutes.post('/bulk', async (c) => {
  const uid = c.get('userId');
  const rows = await readJson(c, z.array(transactionInput).min(1).max(MAX_BULK));

  const allowed = await allowedCategoryIds(c.env.DB, uid);
  for (const r of rows) {
    if (r.category_id != null && !allowed.has(r.category_id)) r.category_id = null;
  }

  const seen = new Map<string, number>();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const base = [r.date, toMinor(r.amount), r.type, r.description.toLowerCase().replace(/\s+/g, ' '), r.bank ?? '', r.account_last4 ?? ''].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    stmts.push(insertStmt(c.env.DB, uid, r, await sha256Hex(`${base}|${n}`)));
  }

  let inserted = 0;
  for (let i = 0; i < stmts.length; i += INSERT_CHUNK) {
    const results = await c.env.DB.batch(stmts.slice(i, i + INSERT_CHUNK));
    inserted += results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  }
  noteAudit(c, { detail: { rows: rows.length, inserted, skipped: rows.length - inserted } });
  return c.json({ inserted, skipped: rows.length - inserted });
});

transactionRoutes.patch('/:id', async (c) => {
  const uid = c.get('userId');
  const id = idParam(c);
  const body = await readJson(c, transactionPatch);
  await assertCategory(c.env.DB, uid, body.category_id);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (body.date !== undefined) (sets.push('date = ?'), args.push(body.date));
  if (body.amount !== undefined) (sets.push('amount_minor = ?'), args.push(toMinor(body.amount)));
  if (body.type !== undefined) (sets.push('type = ?'), args.push(body.type));
  if (body.description !== undefined) (sets.push('description = ?'), args.push(body.description));
  if (body.category_id !== undefined) (sets.push('category_id = ?'), args.push(body.category_id));
  if (body.remark !== undefined) (sets.push('remark = ?'), args.push(body.remark));
  if (!sets.length) throw new HTTPException(400, { message: 'Nothing to update' });

  const res = await c.env.DB.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...args, id, uid)
    .run();
  if (!res.meta.changes) notFound('Transaction');
  const row = await c.env.DB.prepare(`${SELECT_TXN} WHERE t.id = ? AND t.user_id = ?`).bind(id, uid).first<TxnRow>();
  return c.json(row ? toApi(row) : null);
});

/** Assign one category to many transactions at once (e.g. "all Uncategorized SWIGGY rows"). */
transactionRoutes.post('/recategorize', async (c) => {
  const uid = c.get('userId');
  const body = await readJson(
    c,
    z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), category_id: z.number().int().positive().nullable() }),
  );
  await assertCategory(c.env.DB, uid, body.category_id);
  // D1 allows at most 100 bound parameters per statement, so update in chunks.
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < body.ids.length; i += 90) {
    const ids = body.ids.slice(i, i + 90);
    stmts.push(
      c.env.DB.prepare(
        `UPDATE transactions SET category_id = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      ).bind(body.category_id, uid, ...ids),
    );
  }
  const results = await c.env.DB.batch(stmts);
  const updated = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  noteAudit(c, { detail: { requested: body.ids.length, updated } });
  return c.json({ updated });
});

transactionRoutes.delete('/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?')
    .bind(idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.body(null, 204) : notFound('Transaction');
});
