-- Audit log retention. The log stays append-only for every normal path: the app's
-- requests can still never delete an entry. The daily scheduled job alone opens a
-- purge window, deletes old entries, closes the window and records a summary, all in
-- one transactional D1 batch. No HTTP route reads or writes audit_purge_window.
--
-- Honest limit: code running inside the Worker could do the same. Truly external
-- tamper-proofing would need an off-database copy (for example a nightly export to R2).

CREATE TABLE audit_purge_window (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  opened_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Same rule as before, except while the purge window is open.
DROP TRIGGER audit_logs_no_delete;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
WHEN NOT EXISTS (SELECT 1 FROM audit_purge_window)
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
