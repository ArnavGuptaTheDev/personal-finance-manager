# Progress

Run order: Phase 1 → 2 → 3 → 4 → 7. Phases 5 and 6 are skipped.
Resume with "continue from PROGRESS.md".

## ACTION NEEDED before anything is pushed

`main` auto-deploys, but migrations are not applied by the build (README §4). Phase 1 queries the new
`deleted_at` columns, so pushing it before migration 0003 is on production would break the live site.
Applying it touches production, so I have not done it. Commits are kept **local** until you:

1. run `npm run db:migrate:remote` (applies `0003_soft_delete.sql`, and any later migrations listed below);
2. then `git push` (or tell me to).

Pending migrations (all additive; no existing column or row is changed):

- `0003_soft_delete.sql`: a nullable `deleted_at` column on 8 tables, plus partial indexes;
- `0004_import_formats.sql`: a new `import_formats` table for saved column mappings;
- `0005_merchant_and_pairs.sql`: nullable `merchant` and `transfer_pair_id` columns on `transactions`, plus
  indexes. Older rows get their merchant filled in by the app the next time you open Transactions;
- `0006_audit_retention.sql`: a new `audit_purge_window` table, and the audit delete-blocking trigger
  re-created so it allows deletes only while that window is open (only the daily cron opens it).

The daily cron (`[triggers]` in `wrangler.toml`) starts on the first deploy after you push.

## Done

- Open items: deploy and data checks left to you; git `user.email` for this repo set to the GitHub noreply
  address (history not rewritten); CLAUDE.md working rules replaced with the new section.
- **Phase 1** (committed locally):
  - Tokens in `global.css` (colour, 4 px spacing, type, radius, shadow, z-index, motion; dark mode = same
    tokens). U14 contrast fixed (`--muted` darker in light, brighter in dark).
  - Components: `src/components/ui/` (Button, Field, Select, Card, Table, Tabs, EmptyState, Skeleton,
    PageHeader) and `src/client/ui/` (toast stack with Undo, native-dialog modal, confirm dialog, button,
    table/list rendering with empty/error/loading states, form validation, tabs). Every page migrated.
  - All 11 `confirm()`/`prompt()` replaced (single deletes use Undo instead of a confirm).
  - Soft delete (migration 0003) with restore routes for every deletable record, bulk delete/restore for
    transactions, Undo toasts (10 s) on every delete and on bulk recategorize. Tests: restore round-trip,
    cross-user restore and bulk delete refused, re-import revives a deleted row.
  - Phone: bottom tab bar (Dashboard, Transactions, Import, Budgets, More sheet with the rest + Sign out),
    tables stack into row cards under 640 px, filters behind a "Filters" button.
  - Smoothness: cross-document view transitions; Speculation-Rules prefetch of `/app/*` on hover; shell
    renders the user from a `sessionStorage` cache of `/api/me` (revalidated after 5 min); owner nav items
    placed last so revealing them moves nothing; fixed avatar slot; skeletons and reserved heights; the
    uncategorized prompt lives inside the Transactions KPI card; parallel fetches on Transactions, Budgets,
    Audit log; login hides itself until the session check redirects.
  - Forms: one validation pattern (native + server `field: message`, inline, focus first error); money
    fields accept `1,234.50`; compact money (`₹5.7L`) on KPIs and charts, full elsewhere; charts drawn at
    real pixel size (12 px labels) and fill their card.
  - Edit screens: loan, EMI, person (name + note), category (rename + kind).
  - Page fixes: Import drag-and-drop; Categories search, collapsible cards, rule counts, expand/collapse
    all; Settings reordered with activity collapsed and lazy-loaded; sidebar background and brand fixed;
    hit targets ≥ 32 px (40 px on phones).
  - Bugs: B5 (client sends its date to `/emis` and `/budgets`), B6 (budget spent net of refunds, never
    below 0), B7 (uncategorized count is debits only), B9 (CSRF-blocked requests logged with the user).
  - F1 (filtered totals on Transactions) and F10 (Active / Settled / All tabs on Loans) folded in.
  - Privacy policy: added that deleted records are kept up to 30 days for undo, then erased.

- **Phase 2** (committed locally): one shortcut manager (`ui/keys.ts`, off while typing or in a dialog, unit
  tested); Ctrl/Cmd+K palette (pages, actions, recent categories, fuzzy match); `g d/t/i/b`, `n`, `/`, `?`
  help overlay listing every shortcut; Transactions list `j/k`/arrows roving focus with announcements, `x`,
  `e`/Enter, `c` (category type-ahead), Delete (with Undo); quick-add with typed day-first dates (resolved
  date shown under the field), category type-ahead, Save and add another (Ctrl+Enter); Import review uses
  the same list keys (`x` include, `c` category).

- **Phase 3** (committed locally, synthetic fixtures only):
  - Formats are pure config (`parsers/formats.ts`); one shared parser. Output for the four existing formats
    is unchanged (all earlier parser tests pass as they were).
  - Two-row headers (R1); account digits from the statement header, else from the file name, shown in the
    review as an editable "Account ending" field that re-checks duplicates when changed (R2); running-balance
    check on every row when a balance column exists, oldest-first or newest-first, mismatches flagged on the
    row and summarised (R3); CSV encoding detection: UTF-8 (BOM or not), UTF-16, else Windows-1252 (R6).
  - Unrecognised files (or "Another bank") open a column-mapping card: header row, column roles, amount rule,
    date order, a sample of the rows, preview; optionally saved as a named format (column titles and rules
    only; the API refuses anything else). Saved formats appear in the Bank picker and can be deleted (Undo).
  - `/api/import-formats` (list, create, delete, restore) with auth, isolation, validation and export tests;
    migration 0004.
  - Fixture suite: 7 synthetic fixtures in `test/fixtures/statements/` with expected JSON, run by
    `test/parsers/fixtures.test.ts`; every fixture with a balance column has zero mismatches (one fixture
    deliberately drops a row to prove mismatches are caught).

- **Phase 4** (committed locally):
  - Merchant normaliser (`src/client/merchant.ts`, shared by Worker and browser; unit tests on statement-
    style samples). Stored in `merchant` on create, import and description edits; older rows backfilled in
    batches. Transactions shows the merchant with the raw description under it (F2).
  - After a category change: "Always put Swiggy in Food? N other transactions will change" with an
    Always button; adds the keyword rule and applies it (F3). Preview and apply share one SQL condition;
    a test checks the counts match.
  - Import review: rows no rule sorts get the category you chose most often for that merchant, with the
    reason shown ("Food & Dining · you chose this for Swiggy 7 times").
  - Categories → Rule health tab: match count per rule, conflicts, your rules that never match, and a
    live "test a rule" preview (keywords and regexes evaluated in the browser).
  - Transfer pairing (F8): "Find transfers" on Transactions lists same-amount debit/credit pairs on two
    of your accounts within 3 days; mark as Self transfer or Card payment (Undo restores the categories);
    paired rows show a Transfer badge and an Unpair button and are left out of totals and budgets even if
    recategorised. Tests for finding, confirming, totals and isolation.

- **Phase 7** (committed locally): daily cron (03:00 IST) in `server/worker.ts` → `server/lib/retention.ts`:
  deletes audit entries older than `AUDIT_RETENTION_DAYS` (400), trims the oldest beyond `AUDIT_MAX_ROWS`
  (500,000), records an `audit.purge` summary, all in one transactional batch through the purge window;
  then erases soft-deleted rows older than 30 days and records a summary. Tests: normal-path deletes and
  updates still fail, API requests never open the window, the purge removes exactly the eligible rows,
  the row cap trims oldest first, the deleted-record purge, and a static check that only the retention job
  mentions the window. Privacy policy, ABOUT.md and README updated.

## In progress

- Nothing. All requested phases are done and committed locally; waiting on the migrations and push above.

## Next

- Your decisions below, then push.

## Decisions made on your behalf

- CLAUDE.md: the new "Working rules" section replaces the older "Working rules (cost control)" one.
- Plan open questions answered with my recommendations: native view transitions (no ClientRouter); soft
  delete with 30-day purge, account deletion stays immediate; compact money on KPIs/charts; F1 and F10
  folded into Phase 1.
- Prefetch uses a `Speculation-Rules` header instead of Astro's prefetch: `/app/*` pages are `no-store`
  (kept, so the back button never shows a signed-out user's data), and `<link rel=prefetch>` can't reuse
  `no-store` responses. Prefetch only, never prerender, so no API call happens before you navigate.
  Chromium only; others just navigate normally.
- `scripts/ui-audit.mjs` (CLS + axe via headless Chrome) **not written**: you asked for no headless runs,
  and I can't verify it without running it. CLS < 0.05 is designed for (reserved slots, cached shell) but
  not measured.
- Date inputs stay native (best pickers on phones); every displayed date uses the one `3 Oct 2026` format.
- Single deletes have no confirm dialog, only Undo. Bulk delete, revoke access and account deletion still
  confirm (account deletion requires typing DELETE / the email).
- Edits patch rows in place on Transactions; other pages re-fetch their (small) lists after a change.
- A deleted category's transactions read as Uncategorized until it is restored or purged. Creating a
  category with a deleted one's name purges the deleted one immediately.
- Re-importing a statement brings back deleted (not yet purged) rows instead of adding copies.
- The JSON export leaves out records in the 30-day undo window.
- The 409 for a duplicate category name is now `name: …` so it shows under the field.
- Phase 2: "No shortcut fires while typing" is strict: even Ctrl+K is ignored inside a text field. Arrow keys
  only move between rows once a row has focus, so they still scroll the page otherwise. Recently used
  categories are kept as ids in `sessionStorage` (this tab only). The palette's "< 50 ms" is by design
  (built once, no network on open) but not measured, since that needs a browser run.
- Without a year, a typed date more than a month ahead is read as last year ("28/12" typed in January).
- Phase 3: rows imported with a hand-mapped format store the format's name (slugged) as `bank`; unsaved
  mappings store `other`. The mapping UI handles single-row headers only (built-in formats handle two-row
  ones). Saved formats are soft-deleted like everything else, so they get Undo and the 30-day purge.
- Phase 4: rules from corrections and history suggestions key on the merchant name, so they never
  overwrite rows in a transfer pair. "Always" changes every live row with that merchant that is in a
  different category (the preview says how many first). Merchant names are capped at three words; card
  descriptions that end in a city keep it ("Amazon Pay Mumbai") until real statements show a pattern.
- The rule-health counts use the categoriser's keyword and regex matching but not its fuzzy matching,
  so a typo-tolerant match during import won't show up as a match there.
- `npm run typecheck` was failing since Phase 2 (Worker types clash with DOM types in the browser-module
  tests); those tests now have their own `test/tsconfig.unit.json`, and the script checks both.
- Node's `windows-1252` decoder maps 0x80–0x9F as Latin-1, so the parser maps that range itself (€, smart
  quotes, dashes) to behave the same in every browser.

## Needs your decision

- **View logging (Phase 7 proposal, not built):** stop writing a row for every successful GET and keep
  one `session.activity` row per user per day instead (writes, failures, sign-ins and sensitive reads still
  logged individually); cuts audit volume by about 90 %. It changes what the audit log records, so I left
  it for you (PLAN.md open question 8).
- Retention defaults: 400 days / 500,000 rows (change in `wrangler.toml`).
- The privacy policy now says deleted records are kept up to 30 days for undo, and audit entries for 400
  days. Please read sections 6–7 before pushing.
- Migration numbering: Phase 7's migration is `0006` (PLAN.md said `0007` assuming Phase 6 had one).

## Needs real statements (Phase 3)

Everything above is verified only against synthetic files I built to match the layouts the parser already
knew. Still to do once you send anonymised originals (Open question 6 in PLAN.md):

- Check each built-in format against a real download: HDFC savings `.xls`, HDFC card, ICICI savings `.xls`
  and iMobile CSV, ICICI card CSV. In particular: real header titles, footer markers, multi-row headers,
  how reversals and refunds really appear, and whether the account number sits where the patterns look.
- Turn each real file into a fixture with a hand-checked `.expected.json` (kept out of git if it can't be
  fully anonymised; synthetic look-alikes go in the repo).
- Confirm the balance check on real statements (rounding, opening-balance rows, newest-first order).
- A real file that fails today, to confirm it reaches the mapping card and maps cleanly.
- PDF statements (proposal only, not built): estimate and recommendation need one text PDF and one
  password-protected PDF. Expected shape: pdf.js (~1 MB, self-hosted) loaded only on Import, unlocked locally,
  per-bank text-to-table rules; scanned PDFs can't be read.
