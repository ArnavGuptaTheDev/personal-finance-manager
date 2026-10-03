-- Merchant names and transfer pairs. Adds nullable columns only; no existing value changes.
--   merchant:         short name derived from the description ("Swiggy"), filled on save and
--                     backfilled for older rows by the app;
--   transfer_pair_id: set on both halves of a confirmed transfer between your own accounts
--                     (the debit's id), which keeps the pair out of income and spending.
ALTER TABLE transactions ADD COLUMN merchant TEXT;
ALTER TABLE transactions ADD COLUMN transfer_pair_id INTEGER;

CREATE INDEX transactions_user_merchant ON transactions(user_id, merchant);
CREATE INDEX transactions_pair ON transactions(user_id, transfer_pair_id) WHERE transfer_pair_id IS NOT NULL;
