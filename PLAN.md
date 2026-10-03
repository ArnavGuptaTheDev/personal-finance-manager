# Plan: Personal Finance Manager polish

This plan is based on [AUDIT.md](AUDIT.md); finding IDs (U1, C2, B1, …) refer to that file.
Each phase:

- is worked on its own branch and merged to `main` only after you approve;
- ends with type checks plus the full test suite, a summary, and a list of anything deferred.

The hard constraints apply throughout: free Cloudflare plan only, no heavy framework, no change to the
privacy or security model, new migrations only, and surgical edits.

## Where I'd change the brief

1. **Cross-document view transitions instead of Astro's `<ClientRouter />`.**
   - The ClientRouter turns the site into a client-side router: every page script would have to be rewritten
     to re-initialise on `astro:page-load` and clean up its listeners. That is a rewrite with leak risks.
   - Native CSS `@view-transition { navigation: auto; }` plus Astro's prefetch gives the same smooth feel.
     It needs no JS, keeps the MPA, and keeps the strict CSP (Astro hashes its prefetch script).
   - Firefox doesn't animate cross-document view transitions yet. It still gets the prefetch, skeletons and
     zero-shift layout, which remove most of the choppiness on their own.
2. **"Undo" for deletes needs soft delete on the server.** A client-side delay loses the delete if the tab
   closes, and re-inserting rows changes ids and breaks the audit trail.
   - Proposal: a `deleted_at` column on user-data tables (migration), excluded from every query, purged for
     good after 30 days by the Phase 7 cron.
   - Account deletion stays an immediate hard delete.
3. **Regex rule previews run in the browser, never on the server.** User-written regex on the server is a
   ReDoS risk, which is why regex categorisation already runs client-side. Keyword previews can use SQL.
4. **"Learning" stays deterministic and explainable.** It means merchant normalisation plus "you put this
   merchant in X 7 times", with the reason shown. No ML model: that would be hard to explain and wouldn't
   fit the free plan.
5. **Fix the silent data-loss parser bugs (B1, B2) first**, as a small Phase 0.5 hotfix, before any UI work.
   Today an import can drop transactions or shift dates without telling anyone.
6. **Write the "existing security tests" before Phase 1** (S1). They only existed as one-off scripts. Phase 1
   cannot honestly claim "all security tests still pass" until they are committed.

---

## Phase 0.5: test harness and parser hotfix (small, first)

**Scope**

- Add a test suite:
  - **Vitest** with **`@cloudflare/vitest-pool-workers`**, which runs the real Worker and D1 locally with all
    migrations applied (free, no services);
  - a plain Vitest project for the browser modules (parsers, categoriser, formatting).
- Turn the earlier ad-hoc checks into committed tests:
  - every route returns 401 without a session;
  - members get 403 on admin routes;
  - cross-user read, update and delete attempts fail, for every resource;
  - CSRF origin and JSON content-type enforcement;
  - revocation takes effect immediately;
  - owner rights come from config only;
  - the audit log rejects UPDATE and DELETE;
  - the audit log never contains amounts or descriptions;
  - validation edge cases: dates, paise, lengths.
- Fix B1–B4:
  - a non-date row inside the table becomes a continuation of the previous narration and no longer stops
    the import; only known footer markers or end-of-table end parsing;
  - date cells are read from their raw value, not their display text;
  - negative amounts become credits;
  - a row with both a debit and a credit is flagged in the review instead of losing data.
- An import summary that says "N rows read, M skipped (why)", so nothing is ever dropped silently.

**Files:** `package.json`, `vitest.config.ts`, `test/**`, `src/client/parsers/statement.ts`, `src/client/pages/import.ts`.

**Migrations:** none.

**Acceptance**

- `npm test` runs locally and in the Cloudflare build (build command `npm run build` → add `npm test` before it).
- Every API route is covered by an auth test.
- The B1–B4 probes are committed as regression tests and pass.

## Phase 1: design system and smoothness (highest priority)

**Scope**

- **Tokens** (`global.css`): one scale each for colour (semantic: bg, surface, ink, muted, line, brand,
  positive, negative, warning, focus), spacing (4 px base), type, radius, shadow, z-index and motion. Dark
  mode is the same tokens with different values. Fix the U14 contrast.
- **Components**:
  - Astro markup in `src/components/ui/` for button, field (label, input, hint, error), select, table,
    card, tabs, empty state, skeleton and page header;
  - TS helpers in `src/client/ui/` for modal (native `<dialog>`), a confirm dialog that replaces all 11
    `confirm()`/`prompt()` calls (U2), a toast stack with action/undo, timed by type (U3), and
    `renderTable` / `renderList`;
  - every page migrated to these components.
- **Smoothness**:
  - cross-document view transitions and hover/viewport prefetch (C1);
  - the shell renders name, avatar and role instantly from a `sessionStorage` cache of `/api/me`. This holds
    no financial data and is revalidated in the background, so there is no nav or avatar jump (C2, C3, C9);
  - space reserved for every async region: skeletons with fixed heights, and the uncategorized notice gets
    a slot (C4, C5);
  - all page fetches run in parallel (C6);
  - optimistic inline edits with rollback and an error toast, and lists patch rows instead of reloading (C7);
  - deletes and bulk actions show an **Undo** toast (soft delete, see above);
  - the login page redirects before painting when a session exists (C8).
- **Phone**:
  - a bottom tab bar (Dashboard, Transactions, Import, Budgets, More) with More holding the rest plus
    Sign out (P1);
  - tables become stacked row cards under 640 px (P2, P3);
  - filters collapse into a "Filters" sheet (U8).
- **Forms:**
  - one validation pattern: inline field errors from the server's `field: message` responses plus
    native constraints, and focus moves to the first error;
  - one date display format;
  - money input that accepts `1,234.50`.
- **Formatting and charts**: compact money for KPIs and charts (`₹5.7L`), full precision in tables and
  edit forms (U6); readable, responsive chart labels with no empty card space (U7).
- **Page fixes**:
  - Import layout with drag-and-drop (U9);
  - Categories with search, collapsible cards and rule counts (U11);
  - Settings reordered (U12);
  - sidebar fix (U13);
  - bigger hit targets (U15).
- **Missing edit UIs** (B8): edit loan, EMI and person; rename a category and change its kind.
- **Small bugs**:
  - B5: the client sends its local date;
  - B6: budget spent is net of refunds;
  - B7: the uncategorized count is debits only;
  - B9: CSRF-blocked requests are logged with the user when the cookie identifies one.

**Files:** `src/styles/global.css`, `src/components/ui/*`, `src/client/ui/*`, `src/layouts/*`, every
`src/pages/**` and `src/client/pages/*`, `src/client/{shell,dom,format,charts}.ts`, `astro.config.mjs`,
`server/routes/*` (soft delete, restore, B5–B7), `server/app.ts` (B9).

**Migrations:** `0003_soft_delete.sql` adds `deleted_at` to transactions, budgets, categories, keywords,
people, loans, loan payments and EMIs, with partial indexes.

**Acceptance**

- The audit script (committed as `scripts/ui-audit.mjs`, dev-only) reports **CLS < 0.05 on every page** at
  390 px and 1280 px in both themes.
- No horizontal overflow and no clipped values at 390 px.
- No `confirm()`/`prompt()` left anywhere.
- Every delete and bulk action is undoable for 10 s, and restore is tested (including cross-user restore
  being refused).
- axe-core (dev-only, run through the same script) reports no serious or critical violations.
- Every page uses only the shared components (spot-checked by grep: no ad-hoc button classes in page scripts).
- All Phase 0.5 tests pass, plus new tests for the restore routes.

## Phase 2: keyboard-first data entry

**Scope**

- `src/client/ui/keys.ts`: one shortcut manager that ignores keys while focus is in an input, textarea,
  select or contenteditable, or while a modal is open (except Esc).
- Global shortcuts:
  - **Ctrl/Cmd+K** opens the command palette (pages, actions, recent categories);
  - **g d / t / i / b** jump to a page;
  - **n** opens a new transaction;
  - **/** focuses search;
  - **?** shows the shortcut help overlay.
- Transactions list:
  - **j / k** or arrows move the roving focus;
  - **x** selects;
  - **c** opens the category type-ahead;
  - **e** edits;
  - **Enter** saves and **Esc** cancels.
  - The focused row is announced to screen readers.
- Quick-add:
  - fully tab-ordered;
  - natural date input (`today`, `yesterday`, `3/10`, `3 Oct`) that **always reads day-first** and shows the
    resolved date beside the field;
  - category type-ahead;
  - **Save and add another** (Ctrl+Enter).
- Import review uses the same list keyboard model.

**Files:** `src/client/ui/{keys,palette,typeahead,list-nav}.ts`, `src/client/format.ts` (natural dates),
`src/client/pages/{transactions,import}.ts`, `AppShell.astro`.

**Migrations:** none.

**Acceptance**

- Every action in the lists can be done without a mouse.
- No shortcut fires while typing (tested).
- The help overlay lists every shortcut.
- The palette opens in under 50 ms.
- Natural-date parser unit tests pass.

## Phase 3: statement parsing

**Scope**

- Fixture suite under `test/fixtures/statements/` built from your anonymised files (list in Open question 6).
  Each fixture has an expected JSON output, and a closing-balance check validates every row where a balance
  column exists (R3).
- **Declarative bank formats** (R5): a format is pure config (header aliases, column roles, sign
  conventions, date order, footer markers, account-number patterns). Adding a bank means adding one entry.
- Stronger header detection that tolerates multi-row headers (R1), better account detection (R2) and
  encoding detection for CSV (R6).
- **Clear unrecognised-file error** plus a **manual column-mapping fallback** (R4):
  - pick the header row, assign the date, description and amount (or debit/credit) columns, and the sign rule;
  - preview the result, then optionally save the mapping as a named format for reuse.
  - A saved mapping stores column names only, never file content.
- **Proposal only, not built: in-browser PDF statements.**
  - pdf.js loaded only on the Import page (~1 MB, self-hosted, CSP-compatible worker), with
    password-protected PDFs unlocked locally in the browser.
  - Text-to-table reconstruction per bank layout.
  - Risks: layouts differ by statement type, and scanned PDFs can't be read.
  - Estimate and recommendation to follow with the fixtures.

**Files:** `src/client/parsers/{statement,formats,mapping}.ts`, `src/client/pages/import.ts`,
`src/pages/app/import.astro`, `test/parsers/**`.

**Migrations:** `0004_import_formats.sql` (`import_formats`: user_id, name, mapping JSON).

**Acceptance**

- Every fixture parses to its expected output with zero balance mismatches.
- An unrecognised file leads to the mapping UI, never a dead end.
- A new bank needs only a config entry plus a fixture.
- New routes (`/api/import-formats`) are covered by auth and isolation tests.

## Phase 4: categorisation that learns

**Scope**

- **Merchant normalisation**: strip UPI/POS/NEFT prefixes, VPA handles, reference numbers and card masks,
  so `UPI-SWIGGY-SWIGGY8@YBL-412398712` becomes `Swiggy`. Stored in a new `merchant` column (F2).
- **Rule from correction**: when you recategorise, a toast offers "Always put *Swiggy* in Food (12 other
  transactions will change)" and applies on confirm (F3). Counts come from a keyword-preview endpoint (SQL).
- **Suggestions from history**: during import, uncategorised rows get "Food & Dining · you chose this for
  Swiggy 7 times", with the reason shown.
- **Rules screen**:
  - per-rule match counts;
  - conflicts (one transaction matched by rules for different categories);
  - dead rules (zero matches);
  - "test this rule": a live preview over your transactions (regex evaluated in the browser).
- **Transfer pairing** (F8): finds a debit and a credit of the same amount on two of your accounts within
  ±3 days, offers to mark them as a pair (Self Transfer or Credit Card Payment), and excludes the pair from
  totals.

**Files:** `src/client/categorize.ts`, new `src/client/merchant.ts`, `server/routes/{categories,transactions}.ts`
(preview, suggest, pairs), `src/pages/app/categories.astro` → rules screen, `src/client/pages/*`.

**Migrations:** `0005_merchant_and_pairs.sql` adds `merchant` (backfilled by the client on next visit or by
a one-off endpoint) and `transfer_pair_id`, with indexes.

**Acceptance**

- Normaliser unit tests on real-world description samples.
- Preview counts match the applied counts (tested).
- Pairs are found, confirmed and excluded from totals (tested).
- New routes have auth and isolation tests.

## Phase 5: reporting

**Scope**

- Custom date range everywhere (one shared range picker).
- Comparison with the previous period and with the same period last year (F4).
- Category drill-down: trend, top merchants and transactions.
- Savings rate.
- Per-account view (bank and last four digits).
- **Recurring payments and subscriptions**: same merchant, similar amount, regular cadence; shows next
  expected date and monthly cost.
- **CSV export of any filtered view** (F5), generated in the browser from the API's pages. Cells starting
  with `= + - @` are escaped against CSV formula injection.

**Files:** `server/routes/summary.ts` (new aggregate endpoints), `src/pages/app/index.astro`,
new `src/pages/app/reports.astro`, `src/client/{charts,csv}.ts`.

**Migrations:** none expected; indexes only if needed (`0006_report_indexes.sql`).

**Acceptance**

- Aggregates verified against seeded data in tests.
- Every report honours the custom range.
- The CSV round-trips correctly, and the injection-escaping test passes.

## Phase 6: feature gaps (proposals; you choose)

| Feature | Use case | Size |
|---|---|---|
| **Split transactions** | One ₹3,000 supermarket bill was ₹2,200 groceries and ₹800 household. | M (child rows; totals use splits) |
| **Tags** | Track a trip ("Goa 2026") or a project across categories. | S–M |
| **Link EMI instalments and loan repayments to transactions** (F7) | See whether this month's EMI actually left the account; auto-match by amount and date. | M |
| **Budget rollover** | Unspent ₹1,000 of a ₹5,000 Shopping budget carries into next month. | S |
| **Dashboard alerts** (F6) | "Car EMI due in 3 days", "Food budget at 85 % with 12 days left". | S |
| **Settled-loan filter** (F10) | Hide finished loans by default. | XS |
| **Filtered totals on Transactions** (F1) | "Swiggy in August = ₹4,210" without a calculator. | XS |

F1 and F10 are tiny; I'd fold them into Phase 1 unless you say otherwise.

## Phase 7: audit log retention

**Scope**

- **Cron trigger** (free on Workers) running `scheduled()` in `server/worker.ts` daily:
  - deletes entries older than `AUDIT_RETENTION_DAYS` (default **400**);
  - if more than `AUDIT_MAX_ROWS` remain (default **500,000**, about 150 MB, well within D1's free 5 GB),
    trims oldest-first.
- **Still tamper-proof against normal paths.**
  - A new migration replaces the delete-blocking trigger with one that allows deletes **only while a row
    exists in `audit_purge_window`**.
  - Only the cron writes that table, inside a single D1 batch (transactional): open window → delete →
    close window → insert an `audit.purge` summary row ("removed N rows older than D").
  - No HTTP route can touch it (tested).
  - Honest limit: a compromised Worker could do the same. Truly external tamper-proofing would need an
    off-database copy, for example nightly export to R2, which is free up to 10 GB. That's an option, not
    in this plan.
- **View logging: proposed alternative.**
  - Stop writing a row for each successful GET.
  - Instead log:
    - all writes;
    - all failed or denied requests;
    - sign-in and sign-out;
    - sensitive reads (export, admin pages, audit views);
    - one **`session.activity`** row per user per day listing the pages viewed and counts.
  - This keeps "who used the app, when, and what did they look at" while cutting volume by roughly 90 %
    (the walk-through wrote 126 rows, all successful GETs).
- Update the Privacy Policy (retention period, daily activity summaries), ABOUT.md and README.

**Files:** `server/worker.ts`, `server/lib/audit.ts`, `wrangler.toml` (`[triggers] crons`, vars),
`src/pages/privacy.astro`, `ABOUT.md`, `README.md`.

**Migrations:** `0007_audit_retention.sql` (purge window table, replacement trigger, daily-summary unique index).

**Acceptance**

- Tests prove that normal-path deletes fail, that the purge deletes exactly the eligible rows and records a
  summary, and that the daily summary is idempotent.
- `wrangler dev --test-scheduled` exercises the cron locally.

---

## Open questions

1. **View transitions.** OK to use native cross-document view transitions with prefetch instead of the
   `ClientRouter` (see "Where I'd change the brief", point 1)?
2. **Undo via soft delete.** OK to add `deleted_at` (migration 0003) with a 30-day hard purge? Should
   "Delete account" stay an immediate hard delete? I recommend yes to both.
3. **Phase 0.5 first?** OK to land the test harness and the B1–B4 data-loss fixes before Phase 1?
4. **Test dependencies.** OK to add `vitest` and `@cloudflare/vitest-pool-workers`, plus `axe-core` for the
   UI audit script, as dev dependencies, and to run `npm test` in the Cloudflare build?
5. **Phone navigation.** Bottom tab bar with Dashboard, Transactions, Import, Budgets and More: agreed?
6. **Statement fixtures.** Please send anonymised originals: replace names, account numbers and UPI IDs
   with fake values, but keep the exact layout, header rows, file type and formatting. Re-save only if your
   bank's download is itself re-saved. For each, ideally 2+ months including a wrapped or long narration, a
   refund or reversal, and a Cr row.
   - HDFC savings: net-banking download, `.xls` (and `.csv` if you use it)
   - HDFC credit card: whatever you download (`.xls`/`.csv`; or tell me if it's PDF-only)
   - ICICI savings: net-banking `.xls` **and** iMobile/CSV if you use both
   - ICICI credit card: `.csv` (and `.xls` if available)
   - One file that already fails or imports wrongly today, if you have one
   - Optional for the PDF proposal: one text PDF and one password-protected PDF statement
7. **Money display.** OK to show compact amounts (`₹5.7L`) on KPIs and charts, full `₹5,70,000.00`
   elsewhere?
8. **Audit view logging** (Phase 7): accept the "daily activity summary" alternative? Are 400 days and
   500k rows good defaults?
9. **Branches.** Pushing a branch makes Cloudflare build it as a non-production version (preview URLs are
   off, so nothing is reachable). OK to push phase branches to GitHub, or keep them local until merged?
10. **Small items.** Fold F1 (filtered totals) and F10 (settled-loan filter) into Phase 1?
