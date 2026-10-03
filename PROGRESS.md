# Progress

Run order: Phase 1 → 2 → 3 → 4 → 7. Phases 5 and 6 are skipped.
Resume with "continue from PROGRESS.md".

## ACTION NEEDED before anything is pushed

`main` auto-deploys, but migrations are not applied by the build (README §4). Phase 1 queries the new
`deleted_at` columns, so pushing it before migration 0003 is on production would break the live site.
Applying it touches production, so I have not done it. Commits are kept **local** until you:

1. run `npm run db:migrate:remote` (applies `0003_soft_delete.sql`, and any later migrations listed below);
2. then `git push` (or tell me to).

Pending migrations: `0003_soft_delete.sql` (adds a nullable `deleted_at` column to 8 tables plus partial
indexes; no existing column or row is changed).

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

## In progress

- Phase 2: keyboard-first data entry.

## Next

- Phase 3 (parsing, synthetic fixtures only), Phase 4 (categorisation), Phase 7 (audit retention + purge).

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

## Needs real statements (Phase 3)

_(filled in during Phase 3)_
