import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { noteAudit } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { fromMinor, toMinor } from '../lib/money';
import { restore, softDelete } from '../lib/soft-delete';
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
  account_last4: z.string().regex(/^\d{4}$/).nullable().optional(),
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

type Fingerprinted = { date: string; amount_minor: number; type: string; description: string; bank: string | null; account_last4: string | null };

/** The part of an imported row's duplicate fingerprint that comes from its own fields. */
function dedupeBase(t: Fingerprinted): string {
  return [t.date, t.amount_minor, t.type, t.description.toLowerCase().replace(/\s+/g, ' '), t.bank ?? '', t.account_last4 ?? ''].join('|');
}

/** Fingerprints for a batch; identical rows within one statement get increasing occurrence numbers. */
async function batchKeys(rows: Fingerprinted[]): Promise<string[]> {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  for (const r of rows) {
    const base = dedupeBase(r);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys.push(await sha256Hex(`${base}|${n}`));
  }
  return keys;
}

const asFingerprinted = (r: { date: string; amount: number; type: string; description: string; bank?: string | null; account_last4?: string | null }): Fingerprinted => ({
  date: r.date,
  amount_minor: toMinor(r.amount),
  type: r.type,
  description: r.description,
  bank: r.bank ?? null,
  account_last4: r.account_last4 ?? null,
});

/** Day and month swapped, when both are valid months and differ (e.g. 2026-04-05 ↔ 2026-05-04). */
function swappedDate(iso: string): string | null {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (d > 12 || d === m) return null;
  const dt = new Date(Date.UTC(y, d - 1, m));
  return dt.getUTCMonth() === d - 1 ? dt.toISOString().slice(0, 10) : null;
}

// A transaction whose category was deleted reads as Uncategorized until the category is restored.
const FROM_TXN = 'FROM transactions t LEFT JOIN categories c ON c.id = t.category_id AND c.deleted_at IS NULL';
const SELECT_TXN = `SELECT t.id, t.date, t.amount_minor, t.type, t.description, c.id AS category_id, c.name AS category_name,
                           t.bank, t.account_type, t.account_last4, t.remark
                      ${FROM_TXN}`;
const LIVE = 't.deleted_at IS NULL';

transactionRoutes.get('/', async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid filters' });
  const f = parsed.data;

  const where = ['t.user_id = ?', LIVE];
  const args: (string | number)[] = [c.get('userId')];
  if (f.from) (where.push('t.date >= ?'), args.push(f.from));
  if (f.to) (where.push('t.date <= ?'), args.push(f.to));
  if (f.type) (where.push('t.type = ?'), args.push(f.type));
  if (f.category === 'none') where.push('c.id IS NULL');
  else if (f.category) (where.push('c.id = ?'), args.push(f.category));
  if (f.q) {
    // Escape LIKE wildcards so user input is matched literally.
    where.push("(t.description LIKE ? ESCAPE '\\' OR t.remark LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(like, like);
  }
  const whereSql = where.join(' AND ');

  type Totals = { total: number; debit_minor: number; credit_minor: number };
  const [rows, count] = await c.env.DB.batch<TxnRow | Totals>([
    c.env.DB.prepare(`${SELECT_TXN} WHERE ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).bind(
      ...args,
      f.limit,
      f.offset,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN t.type = 'debit' THEN t.amount_minor END), 0) AS debit_minor,
              COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount_minor END), 0) AS credit_minor
         ${FROM_TXN} WHERE ${whereSql}`,
    ).bind(...args),
  ]);
  const totals = (count?.results[0] as Totals | undefined) ?? { total: 0, debit_minor: 0, credit_minor: 0 };
  return c.json({
    items: ((rows?.results ?? []) as TxnRow[]).map(toApi),
    total: totals.total,
    // Sums for the whole filtered view, not just this page.
    totals: { debit: fromMinor(totals.debit_minor), credit: fromMinor(totals.credit_minor) },
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
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET deleted_at = NULL WHERE deleted_at IS NOT NULL`,
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
 * apart by their occurrence index. Re-importing a row that was deleted (and not
 * yet purged) brings the stored row back instead of adding a copy.
 */
transactionRoutes.post('/bulk', async (c) => {
  const uid = c.get('userId');
  const rows = await readJson(c, z.array(transactionInput).min(1).max(MAX_BULK));

  const allowed = await allowedCategoryIds(c.env.DB, uid);
  for (const r of rows) {
    if (r.category_id != null && !allowed.has(r.category_id)) r.category_id = null;
  }

  const keys = await batchKeys(rows.map(asFingerprinted));
  const stmts = rows.map((r, i) => insertStmt(c.env.DB, uid, r, keys[i]!));

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
  if (body.account_last4 !== undefined) (sets.push('account_last4 = ?'), args.push(body.account_last4));
  if (!sets.length) throw new HTTPException(400, { message: 'Nothing to update' });

  const res = await c.env.DB.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(...args, id, uid)
    .run();
  if (!res.meta.changes) notFound('Transaction');
  const fingerprintChanged = ['date', 'amount', 'type', 'description', 'account_last4'].some((k) => body[k as keyof typeof body] !== undefined);
  if (fingerprintChanged) await refreshDedupeKey(c.env.DB, uid, id);
  const row = await c.env.DB.prepare(`${SELECT_TXN} WHERE t.id = ? AND t.user_id = ?`).bind(id, uid).first<TxnRow>();
  return c.json(row ? toApi(row) : null);
});

/**
 * After an imported row is corrected, give it the fingerprint its corrected values
 * would get on import, so re-importing the statement recognises it as already there.
 */
async function refreshDedupeKey(db: D1Database, uid: number, id: number) {
  const row = await db
    .prepare('SELECT date, amount_minor, type, description, bank, account_last4, dedupe_key FROM transactions WHERE id = ? AND user_id = ?')
    .bind(id, uid)
    .first<Fingerprinted & { dedupe_key: string | null }>();
  if (!row?.dedupe_key) return;
  const base = dedupeBase(row);
  for (let n = 1; n <= 50; n++) {
    const key = await sha256Hex(`${base}|${n}`);
    if (key === row.dedupe_key) return;
    const taken = await db.prepare('SELECT 1 FROM transactions WHERE user_id = ? AND dedupe_key = ? AND id <> ?').bind(uid, key, id).first();
    if (!taken) {
      await db.prepare('UPDATE transactions SET dedupe_key = ? WHERE id = ? AND user_id = ?').bind(key, id, uid).run();
      return;
    }
  }
}

const reconcileInput = z.object({
  rows: z
    .array(
      z.object({
        date: isoDate,
        amount: money,
        type: z.enum(['debit', 'credit']),
        description: z.string().trim().min(1).max(500),
        bank: optionalText(40),
        account_last4: z.string().regex(/^\d{4}$/).nullish(),
      }),
    )
    .min(1)
    .max(MAX_BULK),
});

type Existing = Fingerprinted & { id: number; dedupe_key: string };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Before an import is saved, classify each parsed row against what is already stored:
 *  - duplicate: identical to an imported row (same fingerprint);
 *  - changed:   the same transaction imported earlier with different values, e.g. a
 *               day/month-swapped date, a description that has since gained its wrapped
 *               continuation, a reversal stored with the wrong direction, or wrong last
 *               four digits. The caller can correct the stored row instead of adding a copy;
 *  - new:       not stored yet.
 */
transactionRoutes.post('/reconcile', async (c) => {
  const uid = c.get('userId');
  const { rows } = await readJson(c, reconcileInput);
  const fps = rows.map(asFingerprinted);
  const keys = await batchKeys(fps);

  const existingKeys = new Set<string>();
  const lookups: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    lookups.push(
      c.env.DB.prepare(
        `SELECT dedupe_key FROM transactions WHERE user_id = ? AND deleted_at IS NULL AND dedupe_key IN (${chunk.map(() => '?').join(',')})`,
      ).bind(uid, ...chunk),
    );
  }
  for (const res of await c.env.DB.batch<{ dedupe_key: string }>(lookups)) for (const r of res.results) existingKeys.add(r.dedupe_key);

  const dates = fps.flatMap((r) => [r.date, swappedDate(r.date) ?? r.date]).sort();
  const { results: candidates } = await c.env.DB.prepare(
    `SELECT id, date, amount_minor, type, description, bank, account_last4, dedupe_key FROM transactions
      WHERE user_id = ? AND dedupe_key IS NOT NULL AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
  )
    .bind(uid, dates[0], dates.at(-1))
    .all<Existing>();
  const claimed = new Set(candidates.filter((x) => existingKeys.has(x.dedupe_key)).map((x) => x.id));

  const results = fps.map((r, i) => {
    if (existingKeys.has(keys[i]!)) return { status: 'duplicate' as const };
    const swapped = swappedDate(r.date);
    const desc = norm(r.description);
    const match = candidates.find((x) => {
      if (claimed.has(x.id) || x.amount_minor !== r.amount_minor || (x.bank ?? null) !== r.bank) return false;
      const sameDate = x.date === r.date || x.date === swapped;
      const old = norm(x.description);
      const sameDesc = old === desc || (old.length >= 8 && desc.startsWith(old));
      const anyChange = x.date !== r.date || old !== desc || x.type !== r.type || x.account_last4 !== r.account_last4;
      return sameDate && sameDesc && anyChange;
    });
    if (!match) return { status: 'new' as const };
    claimed.add(match.id);
    const changes = [
      match.date !== r.date && 'date',
      norm(match.description) !== desc && 'description',
      match.type !== r.type && 'type',
      match.account_last4 !== r.account_last4 && 'account',
    ].filter(Boolean) as string[];
    return {
      status: 'changed' as const,
      match: { id: match.id, date: match.date, description: match.description, type: match.type, account_last4: match.account_last4 },
      changes,
    };
  });

  const count = (s: string) => results.filter((r) => r.status === s).length;
  noteAudit(c, { detail: { rows: rows.length, duplicate: count('duplicate'), changed: count('changed'), new: count('new') } });
  return c.json({ results });
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
        `UPDATE transactions SET category_id = ? WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
      ).bind(body.category_id, uid, ...ids),
    );
  }
  const results = await c.env.DB.batch(stmts);
  const updated = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  noteAudit(c, { detail: { requested: body.ids.length, updated } });
  return c.json({ updated });
});

const idsInput = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

/** Soft-delete (or restore) many of the caller's transactions; other users' ids are ignored. */
async function setDeleted(db: D1Database, uid: number, ids: number[], deleted: boolean): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    stmts.push(
      db
        .prepare(
          `UPDATE transactions SET deleted_at = ${deleted ? 'unixepoch()' : 'NULL'}
            WHERE user_id = ? AND deleted_at IS ${deleted ? 'NULL' : 'NOT NULL'} AND id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(uid, ...chunk),
    );
  }
  const results = await db.batch(stmts);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

transactionRoutes.post('/delete', async (c) => {
  const { ids } = await readJson(c, idsInput);
  const deleted = await setDeleted(c.env.DB, c.get('userId'), ids, true);
  noteAudit(c, { detail: { requested: ids.length, deleted } });
  return c.json({ deleted });
});

transactionRoutes.post('/restore', async (c) => {
  const { ids } = await readJson(c, idsInput);
  const restored = await setDeleted(c.env.DB, c.get('userId'), ids, false);
  noteAudit(c, { detail: { requested: ids.length, restored } });
  return c.json({ restored });
});

transactionRoutes.delete('/:id', async (c) => {
  return (await softDelete(c.env.DB, 'transactions', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Transaction');
});

transactionRoutes.post('/:id/restore', async (c) => {
  const uid = c.get('userId');
  const id = idParam(c);
  if (!(await restore(c.env.DB, 'transactions', id, uid))) notFound('Deleted transaction');
  const row = await c.env.DB.prepare(`${SELECT_TXN} WHERE t.id = ? AND t.user_id = ?`).bind(id, uid).first<TxnRow>();
  return c.json(row ? toApi(row) : null);
});
