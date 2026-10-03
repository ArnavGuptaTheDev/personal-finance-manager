# Personal Finance Manager

Track spending, budgets, informal loans and EMIs. Import HDFC / ICICI statements
(savings and credit card), auto-categorize transactions, and see where the money goes.

Runs entirely on Cloudflare's free tier:

| Part | Tech | Where |
|---|---|---|
| Pages (UI) | [Astro](https://astro.build) static output + small vanilla TypeScript scripts | Cloudflare Workers static assets |
| API | [Hono](https://hono.dev) Worker (`/api/*`) | Cloudflare Workers |
| Database | SQLite via Cloudflare D1 | Cloudflare D1 |
| Sign-in | Google OAuth 2.0 / OpenID Connect | Google Cloud |
| Statement parsing | [SheetJS](https://sheetjs.com), **in the browser**: files are never uploaded | — |

---

## 1. Prerequisites

- Node.js 20+ (`node -v`)
- A free Cloudflare account
- A Google account (for the OAuth client)

```sh
npm install
```

## 2. Create the Google OAuth client (one time)

1. Open <https://console.cloud.google.com/apis/credentials> and create (or pick) a project.
2. **OAuth consent screen**: choose *External*, fill in the app name and your email.
   Under *Audience*, add your own Google address as a test user (or publish the app).
3. **Create credentials → OAuth client ID → Web application.**
4. Under **Authorized redirect URIs** add both:
   - `http://localhost:8788/api/auth/callback` (local development)
   - `https://pfm.arnavg.me/api/auth/callback` (production)
5. Copy the **Client ID** and **Client secret**.

## 3. Local development

```sh
cp .dev.vars.example .dev.vars        # then paste your Google client ID/secret and set OWNER_EMAILS
npm run db:migrate:local              # creates the local SQLite DB with tables + built-in categories
npm run dev                           # builds the site and serves site + API on http://localhost:8788 (wrangler dev)
```

Open **http://localhost:8788** (use `localhost`, not `127.0.0.1`, so it matches the Google redirect URI).

`npm run dev` rebuilds only when restarted. For live-reloading UI work, run the API in one
terminal and Astro's dev server in another:

```sh
npm run dev                           # terminal 1: API (+ built site) on :8788
npm run dev:ui                        # terminal 2: live UI on http://localhost:4321, /api proxied to :8788
```

Sign in through **:8788** at least once (the cookie is shared across localhost ports), then use :4321.

Useful commands:

```sh
npm test                              # all tests (about 10 s): API security suite + statement parsers
npm run typecheck                     # type-check UI (astro check), API and tests (tsc)
npx wrangler d1 execute finance-db --local --command "SELECT COUNT(*) FROM transactions"
```

### Tests

- `test/api/`: runs the real Worker (`server/worker.ts`) and a local D1 with every migration applied, inside the
  Workers runtime (`@cloudflare/vitest-pool-workers`). It covers authentication on every route, roles,
  per-user isolation for every resource, CSRF and request-format checks, Google sign-in, the audit log and
  import reconciliation. A test fails if a new API route is added without being listed in `security.test.ts`.
- `test/unit/`: statement parsers, run in Node against **synthetic** statements generated in
  `statement-builders.ts`.

`npm run build` runs the tests first, so a failing test stops a Cloudflare deploy.

Real bank statements, even anonymised ones, are **never committed**. Keep them in the git-ignored `samples/`
folder for local checks, and turn what they reveal into synthetic test cases.


## 4. Deploy to Cloudflare (free, auto-deploys from GitHub)

One-time setup. After this, every `git push` to `main` redeploys automatically.

1. **Database** (skip if already done):
   ```sh
   npx wrangler login
   npx wrangler d1 create finance-db          # paste the database_id into wrangler.toml
   npm run db:migrate:remote                  # creates the tables in production
   ```
2. **Connect GitHub**: Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick this
   repository. The Worker name must equal `name` in `wrangler.toml` (`personal-finance-manager`). Then:
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Production branch: `main`

   `wrangler.toml` provides everything else: the static files in `dist`, the `/api/*` Worker, the D1 binding,
   `APP_URL`, and the custom domain `pfm.arnavg.me` (created automatically on deploy; the `arnavg.me` zone must
   be in the same Cloudflare account). `.node-version` pins Node 22.
3. **Secrets**: Worker → **Settings → Variables and Secrets** → add as type *Secret*:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAILS`. (Or `npx wrangler secret put <NAME>`.)
   Secrets survive deploys; plain variables come from `wrangler.toml`.
4. **Google Cloud Console** → OAuth client → Authorized redirect URI `https://pfm.arnavg.me/api/auth/callback`.
   On the consent screen set the homepage to `https://pfm.arnavg.me` and the privacy policy to
   `https://pfm.arnavg.me/privacy/`, then **Publish app**.
5. Push to `main` (or click **Retry build**) and sign in at `https://pfm.arnavg.me`.

### Day-to-day

- Code changes: commit and `git push`. Cloudflare builds and deploys `main` in about a minute. There are no
  workers.dev or preview URLs (disabled in `wrangler.toml`), so the app only exists at `APP_URL`.
- **Database changes are not applied by the build.** Add `migrations/000N_name.sql`, run
  `npm run db:migrate:remote`, then push.
- Manual deploy without Git: `npm run deploy`.
- Backup: `npx wrangler d1 export finance-db --remote --output backup.sql`.

### What it costs

Nothing for personal use. Free-tier limits at the time of writing: static asset requests are free and unlimited,
the Worker allows 100,000 API requests/day, builds are included, and D1 allows 5 GB storage and 5 million row
reads/day.

## Who can sign in

The app is **invite-only** and fails closed:

- **Owners** are the Google emails in `OWNER_EMAILS` (a secret, comma separated). Owners can sign in, use the
  app for themselves, invite or remove people under **Access**, and read the **Audit log**. Owners are managed
  only through `OWNER_EMAILS`. Removing an email there demotes that person on their very next request.
- **Members** are emails an owner invited from **Access**. They use the app for their own finances.
  **Revoke** signs them out everywhere immediately and keeps their data, so access can be restored later.
  **Delete account** removes their data permanently.
- **Everyone else** is refused before an account is even created. If `OWNER_EMAILS` is empty, nobody can sign in.

Nobody can see anyone else's financial data, owners included. Owners see *activity* (who did what, when, and from
which IP and browser) but never transactions, amounts, descriptions, budgets, loans or EMIs.

### Audit log

Every API request writes one row to `audit_logs`: sign-ins (including denied and failed ones), sign-outs,
every view, create, edit, delete and import, admin actions, and blocked requests (missing session, wrong origin,
non-owner hitting admin endpoints). Each row stores time, user, action, result, record id, IP, country and browser.

- Rows never contain financial content. Request bodies and search terms are not logged, only which filter
  *names* were used.
- The table is **append-only**: database triggers reject any `UPDATE`, and any `DELETE` unless a row exists in
  `audit_purge_window`. Only the daily cron (`server/lib/retention.ts`, `[triggers]` in `wrangler.toml`) opens that
  window, inside one transactional batch: open, delete entries older than `AUDIT_RETENTION_DAYS` (400) and the
  oldest beyond `AUDIT_MAX_ROWS` (500,000), close, record an `audit.purge` summary. The same job erases rows
  soft-deleted more than 30 days ago. Try it locally with `npx wrangler dev --test-scheduled`.
- Owners see everything under **Audit log**. Every user sees their own history under **Settings → My activity**.

---

## Where to edit things

| What | File |
|---|---|
| Colours, fonts, spacing (light + dark theme) | `src/styles/global.css` (the `:root` tokens at the top) |
| Landing page copy and features | `src/pages/index.astro` |
| Privacy policy text | `src/pages/privacy.astro` (contact email, URL and date in `src/site.ts`) |
| App name, sidebar links | `src/layouts/AppShell.astro` |
| Built-in categories and keywords | `migrations/0001_init.sql` (for an existing DB, add a new migration) |
| Auto-categorization logic | `src/client/categorize.ts` |
| Bank statement formats / adding a bank | `src/client/parsers/statement.ts` (the `FORMATS` table); add a test in `test/unit/statement.test.ts` |
| Repairing data imported before the parser fixes | [DATA-REPAIR.md](DATA-REPAIR.md), `scripts/detect-suspect-imports.sql` |
| API endpoints | `server/routes/*.ts`, wired up in `server/app.ts` |
| Sign-in, sessions, roles | `server/auth.ts` |
| Admin API (access, audit log) | `server/routes/admin.ts` |
| Audit logging and action names | `server/lib/audit.ts` (labels shown in the UI: `src/client/audit.ts`) |
| Page behaviour (one script per page) | `src/client/pages/*.ts` |
| Security headers for pages | `public/_headers` and `security.csp` in `astro.config.mjs` |

## Project layout

```
astro.config.mjs        Astro config (static output, strict CSP)
wrangler.toml           Cloudflare Worker + static assets + D1 config
migrations/             SQL schema + seed data (applied with wrangler d1 migrations)
server/worker.ts        Worker entry: /api/* goes to the Hono app (everything else is static)
server/                 API: app.ts (middleware), auth.ts (Google OAuth + sessions), routes/
src/pages/              Pages: / (landing), /login, /app/* (signed-in area)
src/layouts/            Base HTML + app shell (sidebar)
src/client/             Browser code: API client, DOM helpers, charts, parsers, per-page scripts
public/                 Static files and _headers
```

## Security model

- **No passwords.** Sign-in is Google OAuth with PKCE, `state` and `nonce`. The client secret stays on the
  server. ID token claims (issuer, audience, expiry, nonce, verified email) are checked.
- **Sessions** are 256-bit random tokens in `__Host-` cookies that are `HttpOnly`, `Secure` and `SameSite=Lax`,
  so JavaScript can't read them. Only a SHA-256 hash is stored in the database. They last 14 days and are
  renewed automatically while you keep using the app.
- **Per-user isolation.** Every query filters by the signed-in user's id. Composite foreign keys stop a loan
  from pointing at another user's person. Built-in categories are read-only.
- **CSRF.** Every state-changing request must carry this site's `Origin`, on top of SameSite cookies and
  JSON-only bodies.
- **Input validation** with Zod on every endpoint. All SQL uses bound parameters. Money is stored as
  integer paise, so there are no rounding errors.
- **XSS.** The UI never uses `innerHTML`; bank descriptions are inserted as text. A strict hashed
  Content-Security-Policy blocks injected scripts, and pages can't be framed.
- **Privacy.** Statement files are parsed in the browser and never uploaded. Users can export all their
  data or delete their account (all rows are removed by cascade) from **Settings**.
- **Invite-only access** (`OWNER_EMAILS` plus owner-managed invites), re-checked on every request. Revocation is
  instant. Owner rights come only from the secret, never from the database.
- **Append-only audit log** of every request, including denied ones, with no financial data in it.

For extra protection on the free plan, you can add a Cloudflare **WAF rate-limiting rule** for `/api/*`
in the dashboard.
