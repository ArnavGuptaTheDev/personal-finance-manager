-- Invite-only access and an append-only audit log.
--
-- Owners are NOT stored here: they come from the OWNER_EMAILS secret and are
-- re-evaluated on every request, so nothing in the database can grant owner rights.

-- Emails an owner has allowed to use the app. Removing a row revokes access
-- immediately (access is checked on every request). No foreign keys, so the
-- record of who granted access survives account deletion.
CREATE TABLE access_grants (
  email            TEXT    PRIMARY KEY CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  granted_by       INTEGER NOT NULL,
  granted_by_email TEXT    NOT NULL,
  note             TEXT    CHECK (note IS NULL OR length(note) <= 200),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One row per API request (reads included), sign-in attempt and denied action.
-- Rows record WHO did WHAT and WHEN. They never contain financial content
-- (amounts, descriptions, search terms), so owners can see activity but not data.
-- user_id has no foreign key so entries outlive deleted accounts.
CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id     INTEGER,
  user_email  TEXT,
  action      TEXT    NOT NULL,
  outcome     TEXT    NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  method      TEXT,
  path        TEXT,
  status      INTEGER,
  target_id   TEXT,
  detail      TEXT,   -- small JSON object, never financial data
  ip          TEXT,
  country     TEXT,
  user_agent  TEXT
);
CREATE INDEX audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_user ON audit_logs(user_id, id DESC);
CREATE INDEX audit_logs_action ON audit_logs(action, id DESC);

-- Tamper resistance: the application can only append.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
