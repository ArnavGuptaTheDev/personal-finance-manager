import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { fromMinor, toMinor } from '../lib/money';
import { idParam, isoDate, money, notFound, optionalText, readJson, shortText } from '../lib/validate';

// ---------------------------------------------------------------- people ----

export const peopleRoutes = new Hono<AppEnv>();

const personInput = z.object({ name: shortText(80), note: optionalText(300) });

peopleRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, note FROM people WHERE user_id = ? ORDER BY name COLLATE NOCASE',
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
  const row = await c.env.DB.prepare('UPDATE people SET name = ?, note = ? WHERE id = ? AND user_id = ? RETURNING id, name, note')
    .bind(body.name, body.note, idParam(c), c.get('userId'))
    .first();
  return row ? c.json(row) : notFound('Person');
});

peopleRoutes.delete('/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM people WHERE id = ? AND user_id = ?')
    .bind(idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.body(null, 204) : notFound('Person');
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
              COALESCE((SELECT SUM(amount_minor) FROM loan_payments lp WHERE lp.loan_id = l.id AND lp.user_id = l.user_id), 0) AS paid_minor
         FROM loans l JOIN people p ON p.id = l.person_id AND p.user_id = l.user_id
        WHERE l.user_id = ? ORDER BY l.date DESC`,
    ).bind(uid),
    c.env.DB.prepare('SELECT id, loan_id, amount_minor, date, note FROM loan_payments WHERE user_id = ? ORDER BY date').bind(uid),
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

loanRoutes.post('/', async (c) => {
  const b = await readJson(c, loanInput);
  // The composite foreign key (person_id, user_id) rejects other users' people.
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
  const res = await c.env.DB.prepare(
    `UPDATE loans SET person_id = ?, direction = ?, title = ?, amount_minor = ?, date = ?, note = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(b.person_id, b.direction, b.title, toMinor(b.amount), b.date, b.note, idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.json({ ok: true }) : notFound('Loan');
});

loanRoutes.delete('/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM loans WHERE id = ? AND user_id = ?')
    .bind(idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.body(null, 204) : notFound('Loan');
});

loanRoutes.post('/:id/payments', async (c) => {
  const b = await readJson(c, paymentInput);
  const row = await c.env.DB.prepare(
    'INSERT INTO loan_payments (user_id, loan_id, amount_minor, date, note) VALUES (?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(c.get('userId'), idParam(c), toMinor(b.amount), b.date, b.note)
    .first();
  return c.json(row, 201);
});

loanRoutes.delete('/:id/payments/:paymentId', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM loan_payments WHERE id = ? AND loan_id = ? AND user_id = ?')
    .bind(idParam(c, 'paymentId'), idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.body(null, 204) : notFound('Payment');
});
