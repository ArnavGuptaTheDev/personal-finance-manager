import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { restore, softDelete } from '../lib/soft-delete';
import { idParam, notFound, readJson, shortText } from '../lib/validate';

export const categoryRoutes = new Hono<AppEnv>();

const kind = z.enum(['expense', 'income', 'transfer']);
const categoryInput = z.object({ name: shortText(60), kind: kind.default('expense') });
const categoryPatch = z.object({ name: shortText(60).optional(), kind: kind.optional() });

const keywordInput = z
  .object({
    keyword: z.string().trim().toLowerCase().min(2).max(80).optional(),
    regex: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.keyword) !== Boolean(v.regex), 'Provide either keyword or regex')
  .refine((v) => {
    if (!v.regex) return true;
    try {
      new RegExp(v.regex, 'i');
      return true;
    } catch {
      return false;
    }
  }, 'Invalid regular expression');

type CategoryRow = { id: number; name: string; kind: string; user_id: number | null };
type KeywordRow = { id: number; category_id: number; user_id: number | null; keyword: string | null; regex: string | null };

/** Built-in categories plus the user's own, each with the keywords visible to the user. */
categoryRoutes.get('/', async (c) => {
  const uid = c.get('userId');
  const [cats, kws] = await c.env.DB.batch<CategoryRow | KeywordRow>([
    c.env.DB.prepare(
      'SELECT id, name, kind, user_id FROM categories WHERE (user_id IS NULL OR user_id = ?) AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
    ).bind(uid),
    c.env.DB.prepare(
      `SELECT k.id, k.category_id, k.user_id, k.keyword, k.regex
         FROM category_keywords k JOIN categories cat ON cat.id = k.category_id
        WHERE (k.user_id IS NULL OR k.user_id = ?1) AND (cat.user_id IS NULL OR cat.user_id = ?1)
          AND k.deleted_at IS NULL AND cat.deleted_at IS NULL`,
    ).bind(uid),
  ]);
  const keywords = (kws?.results ?? []) as KeywordRow[];
  return c.json(
    ((cats?.results ?? []) as CategoryRow[]).map((cat) => ({
      id: cat.id,
      name: cat.name,
      kind: cat.kind,
      builtin: cat.user_id === null,
      keywords: keywords
        .filter((k) => k.category_id === cat.id)
        .map((k) => ({ id: k.id, keyword: k.keyword, regex: k.regex, builtin: k.user_id === null })),
    })),
  );
});

categoryRoutes.post('/', async (c) => {
  const uid = c.get('userId');
  const body = await readJson(c, categoryInput);
  const clash = await c.env.DB.prepare(
    'SELECT 1 FROM categories WHERE (user_id IS NULL OR user_id = ?) AND lower(name) = lower(?) AND deleted_at IS NULL',
  )
    .bind(uid, body.name)
    .first();
  if (clash) throw new HTTPException(409, { message: 'name: A category with that name already exists' });
  await purgeDeletedNamed(c.env.DB, uid, body.name);
  const row = await c.env.DB.prepare('INSERT INTO categories (user_id, name, kind) VALUES (?, ?, ?) RETURNING id, name, kind')
    .bind(uid, body.name, body.kind)
    .first();
  return c.json({ ...row, builtin: false, keywords: [] }, 201);
});

categoryRoutes.patch('/:id', async (c) => {
  const body = await readJson(c, categoryPatch);
  if (body.name) {
    const clash = await c.env.DB.prepare(
      'SELECT 1 FROM categories WHERE (user_id IS NULL OR user_id = ?) AND lower(name) = lower(?) AND id <> ? AND deleted_at IS NULL',
    )
      .bind(c.get('userId'), body.name, idParam(c))
      .first();
    if (clash) throw new HTTPException(409, { message: 'name: A category with that name already exists' });
    await purgeDeletedNamed(c.env.DB, c.get('userId'), body.name);
  }
  const row = await c.env.DB.prepare(
    `UPDATE categories SET name = COALESCE(?, name), kind = COALESCE(?, kind)
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL RETURNING id, name, kind`,
  )
    .bind(body.name ?? null, body.kind ?? null, idParam(c), c.get('userId'))
    .first();
  return row ? c.json(row) : notFound('Category (built-in categories cannot be edited)');
});

// user_id = ? makes built-in categories and other users' categories untouchable.
// While deleted, its transactions read as Uncategorized and its rules and budget are hidden.
categoryRoutes.delete('/:id', async (c) => {
  return (await softDelete(c.env.DB, 'categories', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Category');
});

categoryRoutes.post('/:id/restore', async (c) => {
  return (await restore(c.env.DB, 'categories', idParam(c), c.get('userId'))) ? c.json({ ok: true }) : notFound('Deleted category');
});

/** Users may add keywords to their own categories or to built-in ones. */
categoryRoutes.post('/:id/keywords', async (c) => {
  const uid = c.get('userId');
  const categoryId = idParam(c);
  const body = await readJson(c, keywordInput);
  const cat = await c.env.DB.prepare('SELECT 1 FROM categories WHERE id = ? AND (user_id IS NULL OR user_id = ?) AND deleted_at IS NULL')
    .bind(categoryId, uid)
    .first();
  if (!cat) notFound('Category');
  const row = await c.env.DB.prepare(
    'INSERT INTO category_keywords (category_id, user_id, keyword, regex) VALUES (?, ?, ?, ?) RETURNING id, keyword, regex',
  )
    .bind(categoryId, uid, body.keyword ?? null, body.regex ?? null)
    .first();
  return c.json({ ...row, builtin: false }, 201);
});

categoryRoutes.delete('/keywords/:id', async (c) => {
  return (await softDelete(c.env.DB, 'category_keywords', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Keyword');
});

categoryRoutes.post('/keywords/:id/restore', async (c) => {
  return (await restore(c.env.DB, 'category_keywords', idParam(c), c.get('userId'))) ? c.json({ ok: true }) : notFound('Deleted keyword');
});

/**
 * The unique-name index also covers deleted categories, so a deleted category with the
 * same name is purged for good before its name is reused.
 */
async function purgeDeletedNamed(db: D1Database, uid: number, name: string) {
  await db.prepare('DELETE FROM categories WHERE user_id = ? AND lower(name) = lower(?) AND deleted_at IS NOT NULL').bind(uid, name).run();
}

/** Ids the user may assign to transactions/budgets: built-in or their own. */
export async function allowedCategoryIds(db: D1Database, uid: number): Promise<Set<number>> {
  const { results } = await db
    .prepare('SELECT id FROM categories WHERE (user_id IS NULL OR user_id = ?) AND deleted_at IS NULL')
    .bind(uid)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}
