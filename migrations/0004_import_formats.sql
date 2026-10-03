-- Statement layouts a person mapped by hand on the Import page, saved for reuse.
-- `mapping` is JSON holding column titles and parsing rules only (validated by the
-- API), never any content from a statement file. New table; nothing existing changes.
CREATE TABLE import_formats (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  mapping    TEXT    NOT NULL CHECK (length(mapping) <= 2000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);
CREATE INDEX import_formats_user ON import_formats(user_id);
CREATE UNIQUE INDEX import_formats_name ON import_formats(user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX import_formats_deleted ON import_formats(deleted_at) WHERE deleted_at IS NOT NULL;
