-- Schema for Cloudflare D1 (SQLite). D1 enforces foreign keys.
-- Money is stored as integer minor units (paise) to avoid floating point errors.
-- Every user-owned row carries user_id and every query filters on it.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  google_sub    TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL,
  name          TEXT,
  picture       TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER
);

-- id is the SHA-256 of the random session token; the raw token only lives in
-- the user's httpOnly cookie, so a database leak does not leak sessions.
CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- user_id NULL = built-in category shared by everyone (read-only).
-- kind = 'transfer' is excluded from income/spend totals (e.g. card bill payments).
CREATE TABLE categories (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind    TEXT    NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'transfer'))
);
CREATE UNIQUE INDEX categories_unique_name ON categories(IFNULL(user_id, 0), lower(name));

CREATE TABLE category_keywords (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  keyword     TEXT CHECK (keyword IS NULL OR length(keyword) BETWEEN 2 AND 80),
  regex       TEXT CHECK (regex IS NULL OR length(regex) BETWEEN 1 AND 200),
  CHECK ((keyword IS NULL) <> (regex IS NULL))
);
CREATE INDEX category_keywords_category ON category_keywords(category_id);
CREATE INDEX category_keywords_user ON category_keywords(user_id);

CREATE TABLE transactions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  type          TEXT    NOT NULL CHECK (type IN ('debit', 'credit')),
  description   TEXT    NOT NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  bank          TEXT,
  account_type  TEXT,
  account_last4 TEXT,
  remark        TEXT,
  -- Set on statement imports so re-importing the same statement skips duplicates.
  dedupe_key    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX transactions_user_date ON transactions(user_id, date DESC);
CREATE INDEX transactions_user_category ON transactions(user_id, category_id);
CREATE UNIQUE INDEX transactions_dedupe ON transactions(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE budgets (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  UNIQUE (user_id, category_id)
);

CREATE TABLE people (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  note    TEXT,
  UNIQUE (id, user_id)
);

-- Composite foreign keys make it impossible to attach a row to another user's person/loan.
CREATE TABLE loans (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id    INTEGER NOT NULL,
  direction    TEXT    NOT NULL CHECK (direction IN ('lent', 'borrowed')),
  title        TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  date         TEXT    NOT NULL,
  note         TEXT,
  UNIQUE (id, user_id),
  FOREIGN KEY (person_id, user_id) REFERENCES people(id, user_id) ON DELETE CASCADE
);
CREATE INDEX loans_user ON loans(user_id);

CREATE TABLE loan_payments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id      INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  date         TEXT    NOT NULL,
  note         TEXT,
  FOREIGN KEY (loan_id, user_id) REFERENCES loans(id, user_id) ON DELETE CASCADE
);
CREATE INDEX loan_payments_loan ON loan_payments(loan_id);

CREATE TABLE emis (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  lender            TEXT,
  installment_minor INTEGER NOT NULL CHECK (installment_minor > 0),
  frequency_unit    TEXT    NOT NULL CHECK (frequency_unit IN ('days', 'weeks', 'months', 'years')),
  frequency_value   INTEGER NOT NULL DEFAULT 1 CHECK (frequency_value BETWEEN 1 AND 365),
  start_date        TEXT    NOT NULL,
  end_date          TEXT    NOT NULL,
  note              TEXT,
  CHECK (end_date >= start_date)
);
CREATE INDEX emis_user ON emis(user_id);

-- ---------------------------------------------------------------------------
-- Built-in categories and keywords (edit these, or add your own in the app).
-- ---------------------------------------------------------------------------
INSERT INTO categories (id, user_id, name, kind) VALUES
  (1,  NULL, 'Food & Dining',      'expense'),
  (2,  NULL, 'Groceries',          'expense'),
  (3,  NULL, 'Shopping',           'expense'),
  (4,  NULL, 'Transport',          'expense'),
  (5,  NULL, 'Fuel',               'expense'),
  (6,  NULL, 'Bills & Utilities',  'expense'),
  (7,  NULL, 'Rent',               'expense'),
  (8,  NULL, 'Entertainment',      'expense'),
  (9,  NULL, 'Health',             'expense'),
  (10, NULL, 'Travel',             'expense'),
  (11, NULL, 'Education',          'expense'),
  (12, NULL, 'Insurance',          'expense'),
  (13, NULL, 'EMI & Loans',        'expense'),
  (14, NULL, 'Fees & Charges',     'expense'),
  (15, NULL, 'Cash Withdrawal',    'expense'),
  (16, NULL, 'Investments',        'transfer'),
  (17, NULL, 'Credit Card Payment','transfer'),
  (18, NULL, 'Self Transfer',      'transfer'),
  (19, NULL, 'Salary',             'income'),
  (20, NULL, 'Interest',           'income'),
  (21, NULL, 'Refunds & Cashback', 'income');

INSERT INTO category_keywords (category_id, user_id, keyword) VALUES
  (1, NULL, 'swiggy'), (1, NULL, 'zomato'), (1, NULL, 'restaurant'), (1, NULL, 'cafe'),
  (1, NULL, 'dominos'), (1, NULL, 'mcdonald'), (1, NULL, 'kfc'), (1, NULL, 'starbucks'),
  (1, NULL, 'pizza'), (1, NULL, 'eatclub'),
  (2, NULL, 'bigbasket'), (2, NULL, 'blinkit'), (2, NULL, 'zepto'), (2, NULL, 'dmart'),
  (2, NULL, 'instamart'), (2, NULL, 'grofers'), (2, NULL, 'jiomart'), (2, NULL, 'more retail'),
  (2, NULL, 'reliance fresh'), (2, NULL, 'supermarket'),
  (3, NULL, 'amazon'), (3, NULL, 'flipkart'), (3, NULL, 'myntra'), (3, NULL, 'ajio'),
  (3, NULL, 'meesho'), (3, NULL, 'nykaa'), (3, NULL, 'decathlon'), (3, NULL, 'ikea'),
  (4, NULL, 'uber'), (4, NULL, 'ola'), (4, NULL, 'rapido'), (4, NULL, 'metro'),
  (4, NULL, 'fastag'), (4, NULL, 'parking'), (4, NULL, 'redbus'),
  (5, NULL, 'petrol'), (5, NULL, 'fuel'), (5, NULL, 'hpcl'), (5, NULL, 'bpcl'),
  (5, NULL, 'iocl'), (5, NULL, 'indian oil'), (5, NULL, 'filling station'),
  (6, NULL, 'electricity'), (6, NULL, 'airtel'), (6, NULL, 'jio'), (6, NULL, 'vodafone'),
  (6, NULL, 'bsnl'), (6, NULL, 'broadband'), (6, NULL, 'bescom'), (6, NULL, 'water bill'),
  (6, NULL, 'gas bill'), (6, NULL, 'recharge'), (6, NULL, 'dth'),
  (7, NULL, 'rent'), (7, NULL, 'nobroker'), (7, NULL, 'house rent'),
  (8, NULL, 'netflix'), (8, NULL, 'spotify'), (8, NULL, 'hotstar'), (8, NULL, 'prime video'),
  (8, NULL, 'bookmyshow'), (8, NULL, 'youtube'), (8, NULL, 'pvr'), (8, NULL, 'inox'),
  (9, NULL, 'pharmacy'), (9, NULL, 'apollo'), (9, NULL, 'hospital'), (9, NULL, 'pharmeasy'),
  (9, NULL, 'clinic'), (9, NULL, 'medical'), (9, NULL, 'diagnostic'), (9, NULL, 'netmeds'),
  (10, NULL, 'makemytrip'), (10, NULL, 'goibibo'), (10, NULL, 'indigo'), (10, NULL, 'air india'),
  (10, NULL, 'irctc'), (10, NULL, 'oyo'), (10, NULL, 'airbnb'), (10, NULL, 'cleartrip'),
  (10, NULL, 'hotel'), (10, NULL, 'akasa'), (10, NULL, 'vistara'),
  (11, NULL, 'school'), (11, NULL, 'college'), (11, NULL, 'udemy'), (11, NULL, 'coursera'),
  (11, NULL, 'tuition'), (11, NULL, 'university'),
  (12, NULL, 'insurance'), (12, NULL, 'lic'), (12, NULL, 'policybazaar'), (12, NULL, 'premium'),
  (13, NULL, 'emi'), (13, NULL, 'loan'), (13, NULL, 'bajaj finance'), (13, NULL, 'nach'),
  (14, NULL, 'charges'), (14, NULL, 'annual fee'), (14, NULL, 'late fee'), (14, NULL, 'gst'),
  (14, NULL, 'finance charge'),
  (15, NULL, 'atm'), (15, NULL, 'cash withdrawal'), (15, NULL, 'nwd'),
  (16, NULL, 'zerodha'), (16, NULL, 'groww'), (16, NULL, 'upstox'), (16, NULL, 'mutual fund'),
  (16, NULL, 'indian clearing corp'), (16, NULL, 'nps'), (16, NULL, 'ppf'), (16, NULL, 'kuvera'),
  (17, NULL, 'credit card payment'), (17, NULL, 'cc payment'), (17, NULL, 'cred club'),
  (17, NULL, 'payment received'), (17, NULL, 'billdesk cc'),
  (19, NULL, 'salary'), (19, NULL, 'payroll'),
  (20, NULL, 'interest'), (20, NULL, 'int pd'), (20, NULL, 'int.pd'),
  (21, NULL, 'refund'), (21, NULL, 'cashback'), (21, NULL, 'reversal');
