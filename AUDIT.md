# Audit: Personal Finance Manager

**Date:** 3 October 2026 · **Commit:** `95196b1` · **Scope:** every page, the API, and the statement parsers.

## Method

- **Local run.** `wrangler dev` with a throwaway D1 database seeded with realistic data:
  134 transactions over six months on two accounts, five budgets, two loans, two EMIs,
  custom categories and rules, an owner, a member and one pending invite.
- **Browser walk-through.** Headless Chrome, driven over the DevTools protocol, opened all 14 pages
  in four variants: desktop at 1280 px and phone at 390 px, each in light and dark mode.
  It recorded:
  - full-page and early (90 ms) screenshots;
  - layout shift (CLS);
  - the API request waterfall;
  - console errors and CSP violations.
- **Parser probes.** Synthetic XLS/XLSX files were run through `parseStatement` to test edge cases.
- **Code read-through.** All of `server/` and `src/`.

## Headline numbers

The CLS threshold for "good" is **0.1**.

| Page | CLS desktop | CLS phone |
|---|---|---|
| Dashboard `/app/` | **0.24** | **0.91** |
| Settings | **0.42** | **0.59** |
| Admin › Audit log | 0.01 | **0.38** |
| Login (when already signed in) | **0.25** | **0.66** |
| Admin › Access | 0.01 | **0.16** |
| Budgets / Categories | 0.00 | **0.13** |
| Transactions | **0.11** | 0.06 |
| Loans | **0.10** | 0.08 |

There were no console errors and no CSP violations on any page; the only log entry is the expected 404 on `/nope`.
Everything was measured against a local server with about 10 ms API latency. On the real network, each
blank-then-fill flash below lasts 100–400 ms longer.

---

## 1. UI inconsistency

| # | Finding | Where |
|---|---|---|
| U1 | **No component layer.** Buttons, inputs, tables, cards and badges are ad-hoc class strings repeated in every page script. Destructive actions show up as red text links on Loans and Transactions, ghost buttons on Budgets, and `×` glyphs on loan payments and keyword chips. | `src/client/pages/*.ts`, `src/styles/global.css` |
| U2 | **Confirmations are browser `confirm()`/`prompt()` dialogs.** There are 11 of them: unstyled, they block the page, and on some mobile browsers they can be suppressed. | `transactions.ts:80`, `budgets.ts:38`, `categories.ts:53`, `emis.ts:30`, `loans.ts:34,44,73`, `admin-access.ts:25,48`, `settings.astro:68` |
| U3 | **Toast.** There is a single toast element with a fixed 3.5 s timeout. A new message replaces the previous one, there is no undo, and errors disappear as fast as successes. | `src/client/dom.ts:58-70` |
| U4 | **No loading state anywhere.** KPIs show `—`, the user name shows `…`, and tables are empty until the data arrives. There are no skeletons. | `src/pages/app/index.astro:20`, `AppShell.astro` |
| U5 | **Empty, error and loading states look different on each page.** Errors only appear as a toast, so a failed load leaves a blank page with no retry. | all page scripts |
| U6 | **Money formatting is noisy.** KPIs and bar labels always show paise (`₹5,70,000.00`). On a 390 px screen the KPI values **overflow their cards** (Spending and Net are clipped). | `format.ts:1`, dashboard phone screenshot |
| U7 | **Chart text is unreadable.** Axis labels are 11 px inside a 640-unit viewBox, which renders at about 7 px on a phone and 9 px on desktop. The chart card also leaves about 200 px of empty space under the chart. | `global.css:229`, `charts.ts` |
| U8 | **Filter forms.** Each takes a full card with an explicit **Apply** button; nothing filters live. On a phone, Transactions and Audit log push all data below a 500 px filter block. | `transactions.astro`, `admin/audit.astro` |
| U9 | **Forms use `.form-grid` auto-fit.** This produces uneven alignment: the Import help text is squeezed into a grid column, Add loan wraps oddly, and the native file input is truncated to "No …sen". | `import.astro:22`, `loans.astro` |
| U10 | **Date inputs follow the browser locale** (`dd-mm-yyyy` on some machines, `mm/dd/yyyy` on others), while the rest of the UI shows `3 Oct 2026`. | all forms |
| U11 | **Categories page.** 22 cards, each with its own inline input; no search, no counts and no way to collapse. On a phone it becomes a very long scroll. | `categories.ts` |
| U12 | **Settings.** "My activity" (50 rows) sits *above* Export and Delete account, so on a phone they are about 3,000 px down. | `settings.astro` |
| U13 | **Sidebar.** It is `100dvh` and sticky, but its background ends at the viewport height on long pages. The brand name wraps onto two lines. | `global.css` `.sidebar`, `.brand` |
| U14 | **Contrast.** Dark-mode primary buttons put dark text on bright green (fine), but the dark-mode `--ink-2` on `--surface-2` badges is about 4.2:1, slightly below AA for small text. | `global.css` dark tokens |
| U15 | **Focus states** exist (`:focus-visible`), but tiny targets (`×` buttons, 13 px checkboxes) fall below the 24 px minimum target size. | `loans.ts`, `categories.ts`, tables |

### Phone layout

| # | Finding |
|---|---|
| P1 | **Navigation.** It becomes a horizontally scrolling icon strip. Settings, Access, Audit log and Sign out are off-screen with no hint; only the active item has a label. |
| P2 | **Tables are not adapted.** Transactions, Recent transactions, Audit log and My activity squeeze the description to about 8 characters per line (e.g. `RAPIDO@YB / L`) and clip the amount and result columns off the right edge. |
| P3 | **The Transactions row actions** (Edit and Delete) are off-screen. |

## 2. Causes of choppiness

| # | Finding | Where |
|---|---|---|
| C1 | **Every navigation is a full page load.** The browser repaints a blank page, re-parses the fonts and CSS, and re-runs `/api/me`. There are no view transitions and no prefetch. | Astro MPA, `astro.config.mjs` |
| C2 | **The owner-only nav items are revealed after `/api/me` returns.** On a phone this resizes the nav bar, so the whole page jumps (this is most of the 0.91 dashboard CLS). | `AppShell.astro:40`, `shell.ts:21` |
| C3 | **The avatar is revealed after load** and shifts the user box. | `AppShell.astro:51`, `shell.ts:26` |
| C4 | **The "uncategorized" notice is unhidden after data arrives**, pushing the charts and lists down. | `index.astro:26`, `dashboard.ts:21` |
| C5 | **Containers with no reserved height** (chart, lists, tables, activity) grow from 0 to full size when data lands. This causes the shifts on Settings, Loans and Transactions. | page `.astro` files |
| C6 | **Sequential requests.** Transactions waits for categories before it loads transactions (`transactions.ts:184-189`). Admin › Audit log runs `/me` → `/admin/users` → `/admin/audit` one after another. Budgets runs categories → budgets. | page scripts |
| C7 | **No optimistic updates.** Every edit (category change, delete, add) waits for the server and then **reloads the whole list**, losing scroll position and selection. | `transactions.ts:83,137,158`, `budgets.ts`, `loans.ts`, `emis.ts` |
| C8 | **Login page flash.** A signed-in user visiting `/login/` sees the sign-in card, then a redirect. | `login.astro` |
| C9 | **`/api/me` is fetched on every page**, adding a round trip and two audit rows per navigation (see D6). | `shell.ts` |

## 3. Bugs

| # | Severity | Finding | Where |
|---|---|---|---|
| B1 | **High (silent data loss)** | **A row without a date ends the import.** A wrapped narration line, or any non-date row in the middle of a statement, stops parsing and every later transaction is dropped without warning. The probe imported 1 of 2 rows. | `statement.ts:186` |
| B2 | **High (wrong data)** | **Real Excel date cells are read through the cell's display format.** For a file saved with `m/d/yy` dates, 5 Apr 2026 imports as **4 May 2026**, and 20 Apr (`4/20/26`) is treated as invalid, which then also triggers B1. | `statement.ts:157-162` (`sheet_to_json raw:false`), `parseDate` |
| B3 | Medium | `parseAmount` takes `Math.abs()`, so a negative withdrawal (a reversal) is imported as a debit instead of a credit. | `statement.ts:61` |
| B4 | Medium | A row with both a debit and a credit keeps only the debit; the credit is silently lost. | `statement.ts:74` |
| B5 | Low | **"Today" uses UTC on the server.** EMI `next_due` and the default budget month are wrong between 00:00 and 05:30 IST. | `emis.ts:74`, `summary.ts:74` |
| B6 | Low | Budget "spent" ignores refunds (credits) in that category, so a returned Amazon order still counts as spent. | `summary.ts` budgets query |
| B7 | Low | **The uncategorized count includes credits.** The dashboard prompt counts incoming money such as transfers from friends; arguably fine, but it is labelled as spending. | `summary.ts` |
| B8 | Low | **No update path is exposed.** The API supports editing loans, EMIs, people notes and categories (rename, change kind), but the UI never calls those endpoints, so typos can only be fixed by deleting and re-creating. | `server/routes/{loans,emis,categories}.ts` vs `src/client` |
| B9 | Low | A CSRF-blocked request is logged without the user, because the origin check runs before authentication. | `server/app.ts` middleware order |

## 4. Features that miss their use case, and missing features

| # | Finding |
|---|---|
| F1 | **Transactions has no totals for the filtered view** (sum of debits and credits). "How much did I spend on Swiggy in August?" can't be answered without a calculator. |
| F2 | **Descriptions are shown raw** (`UPI-SWIGGY-SWIGGY8@YBL-412398712`). There is no merchant name, which also weakens grouping and rules. |
| F3 | **Recategorizing never teaches the app anything.** The same merchant must be fixed again on every import. |
| F4 | **The dashboard has preset ranges only.** There is no custom range, no comparison with the previous period, and no per-account view, although the data stores bank, account type and last four digits. |
| F5 | **There is no export of a filtered view.** Only the full JSON export exists. |
| F6 | **Budgets are flat monthly.** There is no rollover, no warning before going over, and no all-categories total. |
| F7 | **EMIs and loans don't link to real transactions**, so "did this month's EMI actually go out?" can't be answered. |
| F8 | **Transfers between your own accounts are excluded by category only**, so an unrecognized self-transfer inflates both income and spending. |
| F9 | **No keyboard support** beyond native tabbing. |
| F10 | **Settled loans** are listed alongside active ones with no filter or ordering. |

## 5. Parsing weaknesses

| # | Finding |
|---|---|
| R1 | **Header detection.** It requires one row to contain every header alias. A two-row header happened to pass the probe only because the first row was enough, so this is fragile. |
| R2 | **Account detection** only searches the rows above the header, takes the first 4-digit match, and has no way to confirm the result. |
| R3 | **Running balances are ignored.** A closing-balance column, when present, could validate every parsed row and catch B1–B4-style errors automatically. |
| R4 | **Unrecognised files.** The only feedback is "Couldn't find the transaction table". There is no fallback for unrecognised layouts and no column-mapping UI. |
| R5 | **Adding a bank requires code.** Each format is a hand-written function (`FORMATS`) rather than declarative config. |
| R6 | **CSV encoding is assumed to be UTF-8**, so Windows-1252 exports with `₹` or accented names can garble. |
| R7 | **There are no fixture tests.** Parser behaviour is only verified by ad-hoc scripts. |

## 6. Security and testing notes

These don't change the security model, but they matter for the hard constraints.

| # | Finding |
|---|---|
| S1 | **"Existing security tests" don't exist in the repo.** The earlier isolation and CSRF checks were one-off curl scripts. They must be turned into a committed test suite before Phase 1 changes anything. |
| S2 | **Audit volume.** Every navigation writes 2–4 audit rows: `account.view` for `/api/me` plus each page's list calls. The read-only walk-through (56 page loads, no edits) wrote **126 rows: 126 successful GETs, 50 of them `account.view`**. At this rate meaningful events (sign-ins, edits, denials) are a small minority (see Phase 7). |
| S3 | **Audit writes add latency.** `auditTrail` awaits the D1 insert before responding, adding one D1 round trip to every request. |
