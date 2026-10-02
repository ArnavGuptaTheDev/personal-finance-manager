import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { fromMinor, toMinor } from '../lib/money';
import { idParam, isoDate, money, notFound, optionalText, readJson, shortText } from '../lib/validate';

export const emiRoutes = new Hono<AppEnv>();

const emiInput = z
  .object({
    title: shortText(120),
    lender: optionalText(120),
    installment: money,
    frequency_unit: z.enum(['days', 'weeks', 'months', 'years']),
    frequency_value: z.number().int().min(1).max(365).default(1),
    start_date: isoDate,
    end_date: isoDate,
    note: optionalText(500),
  })
  .refine((e) => e.end_date >= e.start_date, { message: 'End date must be on or after start date', path: ['end_date'] });

type EmiRow = {
  id: number;
  title: string;
  lender: string | null;
  installment_minor: number;
  frequency_unit: 'days' | 'weeks' | 'months' | 'years';
  frequency_value: number;
  start_date: string;
  end_date: string;
  note: string | null;
};

/** Due date of installment n (0-based), clamping month-end (31 Jan + 1 month → 28/29 Feb). */
function dueDate(start: string, unit: EmiRow['frequency_unit'], every: number, n: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  if (unit === 'days' || unit === 'weeks') {
    const dt = new Date(Date.UTC(y, m - 1, d + n * every * (unit === 'weeks' ? 7 : 1)));
    return dt.toISOString().slice(0, 10);
  }
  const months = n * every * (unit === 'years' ? 12 : 1);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function schedule(e: EmiRow, today: string) {
  let total = 0;
  let paid = 0;
  let next: string | null = null;
  for (let n = 0; n < 5000; n++) {
    const due = dueDate(e.start_date, e.frequency_unit, e.frequency_value, n);
    if (due > e.end_date) break;
    total++;
    if (due < today) paid++;
    else if (!next) next = due;
  }
  return {
    installments_total: total,
    installments_done: paid,
    next_due: next,
    remaining_amount: fromMinor((total - paid) * e.installment_minor),
  };
}

emiRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, lender, installment_minor, frequency_unit, frequency_value, start_date, end_date, note
       FROM emis WHERE user_id = ? ORDER BY end_date`,
  )
    .bind(c.get('userId'))
    .all<EmiRow>();
  const today = new Date().toISOString().slice(0, 10);
  return c.json(
    results.map(({ installment_minor, ...e }) => ({
      ...e,
      installment: fromMinor(installment_minor),
      ...schedule({ installment_minor, ...e }, today),
    })),
  );
});

emiRoutes.post('/', async (c) => {
  const b = await readJson(c, emiInput);
  const row = await c.env.DB.prepare(
    `INSERT INTO emis (user_id, title, lender, installment_minor, frequency_unit, frequency_value, start_date, end_date, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(c.get('userId'), b.title, b.lender, toMinor(b.installment), b.frequency_unit, b.frequency_value, b.start_date, b.end_date, b.note)
    .first();
  return c.json(row, 201);
});

emiRoutes.put('/:id', async (c) => {
  const b = await readJson(c, emiInput);
  const res = await c.env.DB.prepare(
    `UPDATE emis SET title = ?, lender = ?, installment_minor = ?, frequency_unit = ?, frequency_value = ?,
                     start_date = ?, end_date = ?, note = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(b.title, b.lender, toMinor(b.installment), b.frequency_unit, b.frequency_value, b.start_date, b.end_date, b.note, idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.json({ ok: true }) : notFound('EMI');
});

emiRoutes.delete('/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM emis WHERE id = ? AND user_id = ?')
    .bind(idParam(c), c.get('userId'))
    .run();
  return res.meta.changes ? c.body(null, 204) : notFound('EMI');
});
