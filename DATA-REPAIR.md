# Repairing data imported before the parser fixes

**Status:** plan only. Nothing here has been run against production, and nothing will be without your approval.

## What may be wrong in existing data

Imports made before the Phase 0.5 fixes may contain four kinds of error:

| Bug | What happened | What you'd see |
|---|---|---|
| **B2** day/month swap | `.xls`/`.xlsx` files with real Excel date cells were read through their display format. 5 April under an `m/d/yy` format became **4 May**. | Wrong dates, often in the future relative to the import date. |
| **B1** early stop | Parsing stopped at the first undated row (a wrapped description line), **or** at the first impossible date produced by B2 (e.g. "4/20/26" read as day 4, month 20). | Missing transactions after that point. With B2, an affected import contains **only dates with day ≤ 12**. |
| **B3** reversals | Negative withdrawals were stored as debits. | A reversal counted as spending instead of money back. |
| **R2** card digits | Spaced card numbers ("4321 XXXX XXXX 9876") stored the **first** four digits. | The wrong card ending, on card imports. |

Descriptions of rows *before* an early stop are complete. Only the row that had a wrapped line lost that line.

## Step 1: find suspect imports (read-only)

Run [`scripts/detect-suspect-imports.sql`](scripts/detect-suspect-imports.sql) after replacing `YOUR_EMAIL` with your own email:

```sh
npx wrangler d1 execute finance-db --remote --file scripts/detect-suspect-imports.sql
```

It only runs `SELECT`s, limited to your own rows; it never reads another member's data. It lists:

1. **Every import as one line**, flagged:
   - `SUSPECT` when all its dates have day ≤ 12, the B2 + B1 signature;
   - `CHECK` when it covers under 3 weeks, a possible B1 early stop.
2. **Rows dated after the day they were imported.** These are impossible, so they are almost certainly swapped.
3. **The card endings stored per account.** Compare them with your real cards to spot R2.

The queries were validated locally against a simulated bad import: real dates 1–5 April stored as 4 Jan, 4 Feb, 4 Mar and 4 May. The import was flagged `SUSPECT`, and the 4 May row was listed as impossible.

## Step 2: repair by re-importing the original statements

This is the reliable fix, because the file is the source of truth. After the Phase 0.5 fixes are live:

1. Open **Import** and load the original statement for each `SUSPECT` or `CHECK` import.
2. The review now **reconciles every row against what is already stored** before anything is saved:
   - **Already imported**: identical to a stored row. Unticked, so nothing is added twice.
   - **Stored with different details**: the same transaction stored with a swapped date, a description missing its
     wrapped line, the wrong direction or the wrong card ending. These are listed separately with old → new values.
     **Correct selected** fixes the stored rows in place, keeping their categories and remarks. No copy is added.
   - **New**: rows the old parser dropped. Ticked, ready to import.
   - **Needs a look**: rows the parser flagged (for example, a statement row with both a withdrawal and a deposit).
     Unticked until you decide.
3. Run the detection queries again. The flags for the repaired imports should clear.

### Why re-importing doesn't create duplicates

Each imported row carries a fingerprint built from its date, amount, direction, description and account. Correcting
the date or description changes the fingerprint, so a naive re-import would see the corrected row as new and add a
second copy. Two things prevent that:

- **Reconcile looks past the fingerprint.** It matches the same amount on the same account where the date is equal
  **or day/month-swapped**, the old description is equal to the new one **or a prefix of it**, and the direction
  or card ending may differ. Each stored row can be matched only once.
- **Correcting a stored row refreshes its fingerprint** to what the corrected values would produce on import. The
  next import of the same statement therefore sees it as "Already imported". This is covered by an automated test.

Matching only ever considers your own transactions; this is also tested.

## Step 3: rows whose statement you no longer have

If you can't download a statement again, reconcile has nothing to compare against:

- **Swapped dates**: edit the transaction and fix the date. The fingerprint refreshes automatically.
- **Missing rows**: they can only be added by hand.
- **Reversals stored as debits**: edit the type.

## What I will not do without your approval

- Run anything against the remote database, including these read-only queries; you run them, or approve me running them.
- Change stored rows automatically. Every correction is listed and confirmed by you in the import review.
