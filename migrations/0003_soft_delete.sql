-- Soft delete, so deletes can be undone. Adds a nullable column only: existing rows
-- keep deleted_at = NULL and stay visible. Every query filters on deleted_at IS NULL;
-- rows deleted more than 30 days ago are purged for good by the scheduled job.
-- Account deletion stays an immediate hard delete (ON DELETE CASCADE).

ALTER TABLE transactions      ADD COLUMN deleted_at INTEGER;
ALTER TABLE budgets           ADD COLUMN deleted_at INTEGER;
ALTER TABLE categories        ADD COLUMN deleted_at INTEGER;
ALTER TABLE category_keywords ADD COLUMN deleted_at INTEGER;
ALTER TABLE people            ADD COLUMN deleted_at INTEGER;
ALTER TABLE loans             ADD COLUMN deleted_at INTEGER;
ALTER TABLE loan_payments     ADD COLUMN deleted_at INTEGER;
ALTER TABLE emis              ADD COLUMN deleted_at INTEGER;

-- Partial indexes: the purge job finds deleted rows without scanning live ones.
CREATE INDEX transactions_deleted      ON transactions(deleted_at)      WHERE deleted_at IS NOT NULL;
CREATE INDEX budgets_deleted           ON budgets(deleted_at)           WHERE deleted_at IS NOT NULL;
CREATE INDEX categories_deleted        ON categories(deleted_at)        WHERE deleted_at IS NOT NULL;
CREATE INDEX category_keywords_deleted ON category_keywords(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX people_deleted            ON people(deleted_at)            WHERE deleted_at IS NOT NULL;
CREATE INDEX loans_deleted             ON loans(deleted_at)             WHERE deleted_at IS NOT NULL;
CREATE INDEX loan_payments_deleted     ON loan_payments(deleted_at)     WHERE deleted_at IS NOT NULL;
CREATE INDEX emis_deleted              ON emis(deleted_at)              WHERE deleted_at IS NOT NULL;
