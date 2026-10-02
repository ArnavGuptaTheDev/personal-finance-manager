import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

/** Parse and validate a JSON request body; responds 400 on any problem. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  // JSON only: blocks "simple" cross-site form posts and content-type confusion.
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HTTPException(415, { message: 'Content-Type must be application/json' });
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Body must be valid JSON' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HTTPException(400, { message: `${where}${issue?.message ?? 'Invalid input'}` });
  }
  return parsed.data;
}

/** Parse a positive integer route param (ids). */
export function idParam(c: Context, name = 'id'): number {
  const n = Number(c.req.param(name));
  if (!Number.isSafeInteger(n) || n <= 0) throw new HTTPException(400, { message: `Invalid ${name}` });
  return n;
}

export function notFound(what = 'Resource'): never {
  throw new HTTPException(404, { message: `${what} not found` });
}

// ---- shared field schemas ----

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Invalid date');

/** Positive rupee amount with at most 2 decimals, capped well below float precision limits. */
export const money = z
  .number()
  .positive()
  .max(1_000_000_000_000)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most 2 decimal places');

export const shortText = (max: number) => z.string().trim().min(1).max(max);
export const optionalText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
