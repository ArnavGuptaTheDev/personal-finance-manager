// Categorisation that learns (mounted under /api/transactions): merchant backfill,
// "always put this merchant in X" previews and application, suggestions from your
// own history, rule-health data, and pairing transfers between your own accounts.
// Everything is deterministic and explainable: counts and past choices, no model.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { normalizeMerchant } from '../../src/client/merchant';
import type { AppEnv } from '../env';
import { noteAudit } from '../lib/audit';
import { fromMinor } from '../lib/money';
import { idParam, notFound, readJson } from '../lib/validate';
import { allowedCategoryIds } from './categories';

export const learningRoutes = new Hono<AppEnv>();

const BACKFILL_BATCH = 400;
const SELF_TRANSFER = 18;
const CARD_PAYMENT = 17;

/** Fills `merchant` for older rows, a batch at a time. The client repeats while rows remain. */
learningRoutes.post('/merchants/backfill', async (c) => {
  const uid = c.get('userId');
  const { results } = await c.env.DB.prepare('SELECT id, description FROM transactions WHERE user_id = ? AND merchant IS NULL LIMIT ?')
    .bind(uid, BACKFILL_BATCH)
    .all<{ id: number; description: string }>();
  // '' marks "no merchant in this description" so the row isn't picked up again.
  const stmts = results.map((r) => c.env.DB.prepare('UPDATE transactions SET merchant = ? WHERE id = ? AND user_id = ?').bind(normalizeMerchant(r.description), r.id, uid));
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  const left = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND merchant IS NULL').bind(uid).first<{ n: number }>();
  noteAudit(c, { detail: { updated: results.length } });
  return c.json({ updated: results.length, remaining: left?.n ?? 0 });
});

const ruleInput = z.object({ merchant: z.string().trim().min(2).max(60), category_id: z.number().int().positive() });

async function assertCategory(db: D1Database, uid: number, id: number) {
  if (!(await allowedCategoryIds(db, uid)).has(id)) throw new HTTPException(400, { message: 'category_id: Unknown category' });
}

// Rows a merchant rule applies to: live, same merchant, not part of a transfer pair
// (?1 = category, ?2 = user, ?3 = merchant). Preview and apply share it, so their counts agree.
const RULE_ROWS = 'user_id = ?2 AND deleted_at IS NULL AND transfer_pair_id IS NULL AND lower(merchant) = lower(?3)';
const CHANGES = '(category_id IS NULL OR category_id <> ?1)';

/** How many transactions an "always put <merchant> in <category>" rule matches and would change. */
learningRoutes.get('/rule-preview', async (c) => {
  const parsed = z.object({ merchant: ruleInput.shape.merchant, category_id: z.coerce.number().int().positive() }).safeParse(c.req.query());
  if (!parsed.success) throw new HTTPException(400, { message: 'Invalid rule' });
  const { merchant, category_id } = parsed.data;
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS matches, COALESCE(SUM(${CHANGES}), 0) AS changes FROM transactions WHERE ${RULE_ROWS}`,
  )
    .bind(category_id, c.get('userId'), merchant)
    .first<{ matches: number; changes: number }>();
  return c.json({ matches: row?.matches ?? 0, changes: row?.changes ?? 0 });
});

/** Applies the previewed rule: moves every matching transaction into the category. */
learningRoutes.post('/apply-rule', async (c) => {
  const uid = c.get('userId');
  const { merchant, category_id } = await readJson(c, ruleInput);
  await assertCategory(c.env.DB, uid, category_id);
  const res = await c.env.DB.prepare(
    `UPDATE transactions SET category_id = ?1 WHERE ${RULE_ROWS} AND ${CHANGES}`,
  )
    .bind(category_id, uid, merchant)
    .run();
  noteAudit(c, { detail: { updated: res.meta.changes ?? 0 } });
  return c.json({ updated: res.meta.changes ?? 0 });
});

/** For each merchant, the category you chose most often for it, and how many times. */
learningRoutes.post('/suggest', async (c) => {
  const uid = c.get('userId');
  const { merchants } = await readJson(c, z.object({ merchants: z.array(z.string().trim().min(2).max(60)).min(1).max(300) }));
  const wanted = [...new Set(merchants.map((m) => m.toLowerCase()))];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < wanted.length; i += 90) {
    const chunk = wanted.slice(i, i + 90);
    stmts.push(
      c.env.DB.prepare(
        `SELECT lower(t.merchant) AS merchant, c.id AS category_id, c.name, COUNT(*) AS times
           FROM transactions t JOIN categories c ON c.id = t.category_id AND c.deleted_at IS NULL
          WHERE t.user_id = ? AND t.deleted_at IS NULL AND lower(t.merchant) IN (${chunk.map(() => '?').join(',')})
          GROUP BY lower(t.merchant), c.id ORDER BY times DESC`,
      ).bind(uid, ...chunk),
    );
  }
  const suggestions: Record<string, { category_id: number; name: string; times: number }> = {};
  for (const res of await c.env.DB.batch<{ merchant: string; category_id: number; name: string; times: number }>(stmts)) {
    for (const r of res.results) suggestions[r.merchant] ??= { category_id: r.category_id, name: r.name, times: r.times };
  }
  return c.json({ suggestions });
});

/** Descriptions and categories for the rules screen, which evaluates rules (and regexes) in the browser. */
learningRoutes.get('/texts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.description, c.id AS category_id
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id AND c.deleted_at IS NULL
      WHERE t.user_id = ? AND t.deleted_at IS NULL ORDER BY t.date DESC LIMIT 20000`,
  )
    .bind(c.get('userId'))
    .all<{ id: number; description: string; category_id: number | null }>();
  return c.json(results);
});

// ---- transfer pairs ----

type Side = { id: number; date: string; description: string; bank: string | null; account_last4: string | null; amount_minor: number };

/**
 * Candidate transfers between your own accounts: a debit and a credit of the same amount
 * on different accounts within three days, neither already paired. Each transaction is
 * offered once, closest dates first.
 */
learningRoutes.get('/pairs', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.id AS d_id, d.date AS d_date, d.description AS d_description, d.bank AS d_bank, d.account_last4 AS d_last4,
            k.id AS k_id, k.date AS k_date, k.description AS k_description, k.bank AS k_bank, k.account_last4 AS k_last4,
            d.amount_minor, ABS(julianday(d.date) - julianday(k.date)) AS gap
       FROM transactions d
       JOIN transactions k ON k.user_id = d.user_id AND k.type = 'credit' AND k.amount_minor = d.amount_minor
                          AND k.deleted_at IS NULL AND k.transfer_pair_id IS NULL
                          AND ABS(julianday(d.date) - julianday(k.date)) <= 3
                          AND (COALESCE(d.bank, '') <> COALESCE(k.bank, '') OR COALESCE(d.account_last4, '') <> COALESCE(k.account_last4, ''))
      WHERE d.user_id = ? AND d.type = 'debit' AND d.deleted_at IS NULL AND d.transfer_pair_id IS NULL
      ORDER BY gap, d.date DESC LIMIT 500`,
  )
    .bind(c.get('userId'))
    .all<Record<string, string | number | null>>();
  const used = new Set<number>();
  const pairs: { debit: Side; credit: Side; amount: number }[] = [];
  for (const r of results) {
    const [d, k] = [Number(r.d_id), Number(r.k_id)];
    if (used.has(d) || used.has(k)) continue;
    used.add(d);
    used.add(k);
    const side = (p: 'd' | 'k', id: number): Side => ({
      id,
      date: String(r[`${p}_date`]),
      description: String(r[`${p}_description`]),
      bank: (r[`${p}_bank`] as string | null) ?? null,
      account_last4: (r[`${p}_last4`] as string | null) ?? null,
      amount_minor: Number(r.amount_minor),
    });
    pairs.push({ debit: side('d', d), credit: side('k', k), amount: fromMinor(Number(r.amount_minor)) });
    if (pairs.length >= 50) break;
  }
  return c.json(pairs.map(({ debit, credit, amount }) => ({ amount, debit: strip(debit), credit: strip(credit) })));
});

const strip = ({ amount_minor: _, ...s }: Side) => s;

/** Confirms a pair: both halves get the pair id and a transfer category, so totals skip them. */
learningRoutes.post('/pairs', async (c) => {
  const uid = c.get('userId');
  const body = await readJson(c, z.object({ debit_id: z.number().int().positive(), credit_id: z.number().int().positive(), kind: z.enum(['self_transfer', 'card_payment']) }));
  const rows = await c.env.DB.prepare(
    'SELECT id, type, amount_minor FROM transactions WHERE user_id = ? AND id IN (?, ?) AND deleted_at IS NULL AND transfer_pair_id IS NULL',
  )
    .bind(uid, body.debit_id, body.credit_id)
    .all<{ id: number; type: string; amount_minor: number }>();
  const debit = rows.results.find((r) => r.id === body.debit_id && r.type === 'debit');
  const credit = rows.results.find((r) => r.id === body.credit_id && r.type === 'credit');
  if (!debit || !credit) notFound('Unpaired debit and credit');
  if (debit.amount_minor !== credit.amount_minor) throw new HTTPException(400, { message: 'The two amounts differ' });
  const category = body.kind === 'card_payment' ? CARD_PAYMENT : SELF_TRANSFER;
  await c.env.DB.prepare('UPDATE transactions SET transfer_pair_id = ?, category_id = ? WHERE user_id = ? AND id IN (?, ?)')
    .bind(debit.id, category, uid, debit.id, credit.id)
    .run();
  noteAudit(c, { targetId: debit.id });
  return c.json({ pair_id: debit.id, category_id: category }, 201);
});

/** Unpairs (the categories are left as they are; the client puts back the earlier ones on Undo). */
learningRoutes.delete('/pairs/:id', async (c) => {
  const res = await c.env.DB.prepare('UPDATE transactions SET transfer_pair_id = NULL WHERE user_id = ? AND transfer_pair_id = ?')
    .bind(c.get('userId'), idParam(c))
    .run();
  return res.meta.changes ? c.body(null, 204) : notFound('Transfer pair');
});
