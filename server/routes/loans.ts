import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { fromMinor, toMinor } from '../lib/money';
import { restore, softDelete } from '../lib/soft-delete';
import { idParam, isoDate, money, notFound, optionalText, readJson, shortText } from '../lib/validate';

// ---------------------------------------------------------------- people ----

export const peopleRoutes = new Hono<AppEnv>();

const personInput = z.object({ name: shortText(80), note: optionalText(300) });

peopleRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, note FROM people WHERE user_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
  )
    .bind(c.get('userId'))
    .all();
  return c.json(results);
});

peopleRoutes.post('/', async (c) => {
  const body = await readJson(c, personInput);
  const row = await c.env.DB.prepare('INSERT INTO people (user_id, name, note) VALUES (?, ?, ?) RETURNING id, name, note')
    .bind(c.get('userId'), body.name, body.note)
    .first();
  return c.json(row, 201);
});

peopleRoutes.put('/:id', async (c) => {
  const body = await readJson(c, personInput);
  const row = await c.env.DB.prepare(
    'UPDATE people SET name = ?, note = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL RETURNING id, name, note',
  )
    .bind(body.name, body.note, idParam(c), c.get('userId'))
    .first();
  return row ? c.json(row) : notFound('Person');
});

// While a person is deleted, their loans and payments are hidden with them.
peopleRoutes.delete('/:id', async (c) => {
  return (await softDelete(c.env.DB, 'people', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Person');
});

peopleRoutes.post('/:id/restore', async (c) => {
  return (await restore(c.env.DB, 'people', idParam(c), c.get('userId'))) ? c.json({ ok: true }) : notFound('Deleted person');
});

// ----------------------------------------------------------------- loans ----

export const loanRoutes = new Hono<AppEnv>();

const loanInput = z.object({
  person_id: z.number().int().positive(),
  direction: z.enum(['lent', 'borrowed']),
  title: shortText(120),
  amount: money,
  date: isoDate,
  note: optionalText(500),
});

const paymentInput = z.object({ amount: money, date: isoDate, note: optionalText(300) });

type LoanRow = {
  id: number;
  person_id: number;
  person_name: string;
  direction: string;
  title: string;
  amount_minor: number;
  paid_minor: number;
  date: string;
  note: string | null;
};

loanRoutes.get('/', async (c) => {
  const uid = c.get('userId');
  const [loans, payments] = await c.env.DB.batch<LoanRow | { id: number; loan_id: number; amount_minor: number; date: string; note: string | null }>([
    c.env.DB.prepare(
      `SELECT l.id, l.person_id, p.name AS person_name, l.direction, l.title, l.amount_minor, l.date, l.note,
              COALESCE((SELECT SUM(amount_minor) FROM loan_payments lp
                         WHERE lp.loan_id = l.id AND lp.user_id = l.user_id AND lp.deleted_at IS NULL), 0) AS paid_minor
         FROM loans l JOIN people p ON p.id = l.person_id AND p.user_id = l.user_id AND p.deleted_at IS NULL
        WHERE l.user_id = ? AND l.deleted_at IS NULL ORDER BY l.date DESC`,
    ).bind(uid),
    c.env.DB.prepare('SELECT id, loan_id, amount_minor, date, note FROM loan_payments WHERE user_id = ? AND deleted_at IS NULL ORDER BY date').bind(uid),
  ]);
  const pays = (payments?.results ?? []) as { id: number; loan_id: number; amount_minor: number; date: string; note: string | null }[];
  return c.json(
    ((loans?.results ?? []) as LoanRow[]).map((l) => ({
      id: l.id,
      person_id: l.person_id,
      person_name: l.person_name,
      direction: l.direction,
      title: l.title,
      amount: fromMinor(l.amount_minor),
      paid: fromMinor(l.paid_minor),
      outstanding: fromMinor(l.amount_minor - l.paid_minor),
      date: l.date,
      note: l.note,
      payments: pays
        .filter((p) => p.loan_id === l.id)
        .map((p) => ({ id: p.id, amount: fromMinor(p.amount_minor), date: p.date, note: p.note })),
    })),
  );
});

/** The composite foreign key rejects other users' people; this also rejects deleted ones. */
async function assertPerson(db: D1Database, uid: number, personId: number) {
  const ok = await db.prepare('SELECT 1 FROM people WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(personId, uid).first();
  if (!ok) throw new HTTPException(400, { message: 'person_id: Unknown person' });
}

loanRoutes.post('/', async (c) => {
  const b = await readJson(c, loanInput);
  await assertPerson(c.env.DB, c.get('userId'), b.person_id);
  const row = await c.env.DB.prepare(
    `INSERT INTO loans (user_id, person_id, direction, title, amount_minor, date, note)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(c.get('userId'), b.person_id, b.direction, b.title, toMinor(b.amount), b.date, b.note)
    .first();
  return c.json(row, 201);
});

loanRoutes.put('/:id', async (c) => {
  const b = await readJson(c, loanInput);
  const id = idParam(c);
  const uid = c.get('userId');
  const exists = await c.env.DB.prepare('SELECT 1 FROM loans WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, uid).first();
  if (!exists) notFound('Loan');
  await assertPerson(c.env.DB, uid, b.person_id);
  await c.env.DB.prepare(
    `UPDATE loans SET person_id = ?, direction = ?, title = ?, amount_minor = ?, date = ?, note = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
    .bind(b.person_id, b.direction, b.title, toMinor(b.amount), b.date, b.note, id, uid)
    .run();
  return c.json({ ok: true });
});

loanRoutes.delete('/:id', async (c) => {
  return (await softDelete(c.env.DB, 'loans', idParam(c), c.get('userId'))) ? c.body(null, 204) : notFound('Loan');
});

loanRoutes.post('/:id/restore', async (c) => {
  return (await restore(c.env.DB, 'loans', idParam(c), c.get('userId'))) ? c.json({ ok: true }) : notFound('Deleted loan');
});

loanRoutes.post('/:id/payments', async (c) => {
  const b = await readJson(c, paymentInput);
  const live = await c.env.DB.prepare('SELECT 1 FROM loans WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(idParam(c), c.get('userId'))
    .first();
  if (!live) throw new HTTPException(400, { message: 'Unknown loan' });
  const row = await c.env.DB.prepare(
    'INSERT INTO loan_payments (user_id, loan_id, amount_minor, date, note) VALUES (?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(c.get('userId'), idParam(c), toMinor(b.amount), b.date, b.note)
    .first();
  return c.json(row, 201);
});

loanRoutes.delete('/:id/payments/:paymentId', async (c) => {
  const ok = await softDelete(c.env.DB, 'loan_payments', idParam(c, 'paymentId'), c.get('userId'), 'AND loan_id = ?', idParam(c));
  return ok ? c.body(null, 204) : notFound('Payment');
});

loanRoutes.post('/:id/payments/:paymentId/restore', async (c) => {
  const ok = await restore(c.env.DB, 'loan_payments', idParam(c, 'paymentId'), c.get('userId'), 'AND loan_id = ?', idParam(c));
  return ok ? c.json({ ok: true }) : notFound('Deleted payment');
});
