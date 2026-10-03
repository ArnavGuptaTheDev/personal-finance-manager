-- Read-only checks for transactions imported before the parser fixes (B1, B2, R2).
-- Only SELECT statements: running this never changes data.
-- Replace YOUR_EMAIL below. Results are limited to that account's own rows.
--
--   npx wrangler d1 execute finance-db --remote --file scripts/detect-suspect-imports.sql

-- 1. One line per import (rows saved by the same import share a timestamp).
--    SUSPECT  = every date has day <= 12. The old parser read real Excel date cells
--               month-first, then stopped at the first impossible date (day > 12),
--               so an affected import contains only "day <= 12" dates.
--    CHECK    = the import covers less than 3 weeks; it may have stopped early at a
--               wrapped description line.
WITH me AS (SELECT id FROM users WHERE email = 'YOUR_EMAIL'),
batches AS (
  SELECT bank, account_type, account_last4, created_at / 120 AS batch, MIN(created_at) AS imported_at,
         COUNT(*) AS n, MIN(date) AS first_date, MAX(date) AS last_date,
         MAX(CAST(substr(date, 9, 2) AS INTEGER)) AS max_day
    FROM transactions
   WHERE user_id = (SELECT id FROM me) AND dedupe_key IS NOT NULL
   GROUP BY bank, account_type, account_last4, batch
)
SELECT datetime(imported_at, 'unixepoch') AS imported, bank, account_type, account_last4 AS last4, n,
       first_date, last_date, max_day,
       CASE
         WHEN n >= 3 AND max_day <= 12 THEN 'SUSPECT: swapped dates and early stop'
         WHEN julianday(last_date) - julianday(first_date) < 21 THEN 'CHECK: short span, may have stopped early'
         ELSE ''
       END AS flag
  FROM batches
 ORDER BY imported_at;

-- 2. Impossible rows: dated after the day they were imported. A day/month swap
--    usually pushes a date into the future (5 April imported in April becomes 4 May).
WITH me AS (SELECT id FROM users WHERE email = 'YOUR_EMAIL')
SELECT id, date, datetime(created_at, 'unixepoch') AS imported, bank, account_last4 AS last4, type,
       amount_minor / 100.0 AS amount, description
  FROM transactions
 WHERE user_id = (SELECT id FROM me) AND dedupe_key IS NOT NULL AND date > date(created_at, 'unixepoch')
 ORDER BY date;

-- 3. Card numbers as stored. The old parser took the FIRST four digits of a spaced
--    card number ("4321 XXXX XXXX 9876" → 4321). Compare with the real last four
--    digits of each card; a mismatch means those rows need re-importing (see DATA-REPAIR.md).
WITH me AS (SELECT id FROM users WHERE email = 'YOUR_EMAIL')
SELECT bank, account_type, account_last4 AS last4, COUNT(*) AS n, MIN(date) AS first_date, MAX(date) AS last_date
  FROM transactions
 WHERE user_id = (SELECT id FROM me) AND dedupe_key IS NOT NULL
 GROUP BY bank, account_type, account_last4
 ORDER BY bank, account_type;
