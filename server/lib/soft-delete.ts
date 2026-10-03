// Deletes set deleted_at instead of removing the row, so they can be undone.
// Restores only touch the caller's own rows that are actually deleted.
export type SoftTable = 'transactions' | 'budgets' | 'categories' | 'category_keywords' | 'people' | 'loans' | 'loan_payments' | 'emis' | 'import_formats';

export async function softDelete(db: D1Database, table: SoftTable, id: number, uid: number, extra = '', ...extraArgs: number[]): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE ${table} SET deleted_at = unixepoch() WHERE id = ? AND user_id = ? AND deleted_at IS NULL ${extra}`)
    .bind(id, uid, ...extraArgs)
    .run();
  return Boolean(res.meta.changes);
}

export async function restore(db: D1Database, table: SoftTable, id: number, uid: number, extra = '', ...extraArgs: number[]): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL ${extra}`)
    .bind(id, uid, ...extraArgs)
    .run();
  return Boolean(res.meta.changes);
}
