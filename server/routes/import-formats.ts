import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { restore, softDelete } from '../lib/soft-delete';
import { idParam, notFound, readJson, shortText } from '../lib/validate';

export const importFormatRoutes = new Hono<AppEnv>();

// A column title, as printed in a statement's header row.
const title = z.string().trim().min(1).max(80);

// Strict: only column titles and rules are accepted, so no statement content can be stored.
const mapping = z
  .object({
    version: z.literal(1),
    columns: z
      .object({
        date: title,
        description: title,
        amount: title.optional(),
        debit: title.optional(),
        credit: title.optional(),
        sign: title.optional(),
        balance: title.optional(),
      })
      .strict(),
    amounts: z.enum(['split', 'marker', 'negative-debit', 'negative-credit']),
    dateOrder: z.enum(['dmy', 'mdy', 'ymd']),
  })
  .strict()
  .refine((m) => (m.amounts === 'split' ? Boolean(m.columns.debit || m.columns.credit) : Boolean(m.columns.amount)), 'Choose the amount columns')
  .refine((m) => m.amounts !== 'marker' || Boolean(m.columns.sign), 'Choose the column that marks credits');

type Row = { id: number; name: string; mapping: string; created_at: number };

importFormatRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, mapping, created_at FROM import_formats WHERE user_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
  )
    .bind(c.get('userId'))
    .all<Row>();
  return c.json(results.map((r) => ({ ...r, mapping: JSON.parse(r.mapping) as unknown })));
});

importFormatRoutes.post('/', async (c) => {
  const uid = c.get('userId');
  const body = await readJson(c, z.object({ name: shortText(60), mapping }));
  const clash = await c.env.DB.prepare('SELECT 1 FROM import_formats WHERE user_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL')
    .bind(uid, body.name)
    .first();
  if (clash) throw new HTTPException(409, { message: 'name: You already have a format with that name' });
  const row = await c.env.DB.prepare('INSERT INTO import_formats (user_id, name, mapping) VALUES (?, ?, ?) RETURNING id, name, created_at')
    .bind(uid, body.name, JSON.stringify(body.mapping))
    .first<Omit<Row, 'mapping'>>();
  return c.json({ ...row, mapping: body.mapping }, 201);
});

importFormatRoutes.delete('/:id', async (c) => {
  return (await softDelete(c.env.DB, 'import_formats', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Format');
});

importFormatRoutes.post('/:id/restore', async (c) => {
  return (await restore(c.env.DB, 'import_formats', idParam(c), c.get('userId'))) ? c.json({ ok: true }) : notFound('Deleted format');
});
