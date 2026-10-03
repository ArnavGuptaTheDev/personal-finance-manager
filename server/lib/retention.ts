// Daily retention job (the Worker's scheduled handler):
//  1. audit log: delete entries older than AUDIT_RETENTION_DAYS, then trim the oldest
//     if more than AUDIT_MAX_ROWS remain, and record an `audit.purge` summary;
//  2. soft-deleted records: erase rows deleted more than 30 days ago (the undo window).
// This is the only code that touches audit_purge_window; no HTTP route can reach it.
import type { Env } from '../env';

const DAY = 86_400;
export const UNDO_DAYS = 30;
const DEFAULT_RETENTION_DAYS = 400;
const DEFAULT_MAX_ROWS = 500_000;

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

export async function purgeAuditLog(db: D1Database, opts: { retentionDays: number; maxRows: number; now: number }) {
  const cutoff = opts.now - opts.retentionDays * DAY;
  const counts = await db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(created_at < ?), 0) AS old FROM audit_logs')
    .bind(cutoff)
    .first<{ total: number; old: number }>();
  const old = counts?.old ?? 0;
  const excess = Math.max(0, (counts?.total ?? 0) - old - opts.maxRows);

  // Over the row cap: also remove the oldest remaining entries, up to and including this id.
  let trimThrough: number | null = null;
  if (excess > 0) {
    const row = await db
      .prepare('SELECT id FROM audit_logs WHERE created_at >= ? ORDER BY id LIMIT 1 OFFSET ?')
      .bind(cutoff, excess - 1)
      .first<{ id: number }>();
    trimThrough = row?.id ?? null;
  }
  if (!old && trimThrough === null) return { removed: 0, trimmed: 0 };

  const detail = JSON.stringify({ removed: old, older_than: isoDay(cutoff), trimmed: trimThrough === null ? 0 : excess });
  // One transactional batch: if any step fails, nothing is deleted and the window stays closed.
  await db.batch([
    db.prepare('INSERT INTO audit_purge_window (id) VALUES (1)'),
    db.prepare('DELETE FROM audit_logs WHERE created_at < ?').bind(cutoff),
    ...(trimThrough === null ? [] : [db.prepare('DELETE FROM audit_logs WHERE id <= ?').bind(trimThrough)]),
    db.prepare('DELETE FROM audit_purge_window'),
    db.prepare("INSERT INTO audit_logs (action, outcome, detail) VALUES ('audit.purge', 'success', ?)").bind(detail),
  ]);
  return { removed: old, trimmed: trimThrough === null ? 0 : excess };
}

// Children before parents, so nothing is left pointing at a purged row.
const SOFT_TABLES = ['loan_payments', 'loans', 'people', 'emis', 'budgets', 'category_keywords', 'transactions', 'categories', 'import_formats'] as const;

export async function purgeDeletedRecords(db: D1Database, now: number) {
  const cutoff = now - UNDO_DAYS * DAY;
  const results = await db.batch(SOFT_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).bind(cutoff)));
  const erased = Object.fromEntries(SOFT_TABLES.map((t, i) => [t, results[i]?.meta.changes ?? 0]).filter(([, n]) => n));
  if (Object.keys(erased).length) {
    await db
      .prepare("INSERT INTO audit_logs (action, outcome, detail) VALUES ('retention.purge_deleted', 'success', ?)")
      .bind(JSON.stringify({ ...erased, deleted_before: isoDay(cutoff) }))
      .run();
  }
  return erased;
}

export async function runRetention(env: Env, now = Math.floor(Date.now() / 1000)) {
  const audit = await purgeAuditLog(env.DB, {
    retentionDays: positiveInt(env.AUDIT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    maxRows: positiveInt(env.AUDIT_MAX_ROWS, DEFAULT_MAX_ROWS),
    now,
  });
  const deleted = await purgeDeletedRecords(env.DB, now);
  return { audit, deleted };
}
