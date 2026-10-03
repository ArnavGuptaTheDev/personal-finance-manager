# About Personal Finance Manager

Personal Finance Manager is a private, invite-only web app for tracking your own money. You import bank
statements and the app reads them in your browser, sorts each transaction into a category, and shows
where your money goes. It also tracks budgets, money lent to or borrowed from people you know, and
recurring loan EMIs.

- **Live at:** [pfm.arnavg.me](https://pfm.arnavg.me)
- **Who it's for:** individuals (and the people they invite) who want a clear view of their spending without
  spreadsheets, ads or third-party data sharing.
- **Cost to run:** fits within Cloudflare's free plan.

---

## Contents

1. [Features in detail](#1-features-in-detail)
2. [Pages in the app](#2-pages-in-the-app)
3. [Accounts, roles and access](#3-accounts-roles-and-access)
4. [Privacy](#4-privacy)
5. [Security](#5-security)
6. [Audit log](#6-audit-log)
7. [How it is built](#7-how-it-is-built)
8. [What is stored](#8-what-is-stored)
9. [Limitations](#9-limitations)

---

## 1. Features in detail

### Bank statement import

- **Supported banks and accounts:** HDFC Bank and ICICI Bank, each for **savings accounts** and **credit
  cards**. Supported file types are `.xls`, `.xlsx` and `.csv`, up to 5 MB.
- **Parsed on your device:** the statement file is opened and read inside your browser. The file itself is
  never uploaded or stored anywhere. Only the transactions you confirm are sent to the server.
- **Robust reading:** the parser finds the transaction table even when it is surrounded by bank headers,
  account details or summary rows. It understands Indian date formats (`05/04/24`, `05-Apr-2024` and so
  on), Indian number formatting (`1,23,456.78`), separate debit/credit columns, and Cr/Dr markers.
  - Real Excel date cells are read by their stored value, so dates are never day/month-swapped.
  - Description lines that wrap onto the next row are joined back onto their transaction.
  - Negative amounts (reversals) are imported in the right direction and flagged for a look.
  - Anything in the table that can't be read is listed with its line number and reason; nothing is dropped
    silently.
- **Account detection:** the last four digits of the account or card number are picked up automatically
  and stored with each transaction.
- **Review before saving:** every row is shown with its date, description, amount and suggested
  category. You can untick rows you don't want and change any category before importing.
- **Checked against what you already have:** before saving, each row is labelled as **new**, **already
  imported** or **stored with different details**. The last case covers a transaction saved earlier with a
  wrong date, a cut-off description or the wrong card digits. You can correct the stored copy in place
  instead of importing it twice.
- **No duplicates:** each imported row gets a fingerprint, so importing an overlapping statement (for
  example, last month's and this month's) adds only the new transactions. Genuine repeats inside one
  statement, like two identical ₹20 purchases on the same day, are still kept.

### Automatic categorization

- **21 built-in categories**, each with keyword rules tuned for Indian merchants (Swiggy, Zomato, Blinkit,
  Amazon, Uber, IRCTC, Zerodha and others):
  - Food & Dining, Groceries, Shopping, Transport, Fuel, Bills & Utilities, Rent, Entertainment, Health,
    Travel, Education, Insurance, EMI & Loans, Fees & Charges, Cash Withdrawal (expenses)
  - Salary, Interest, Refunds & Cashback (income)
  - Investments, Credit Card Payment, Self Transfer (transfers)
- **Your own rules:** add keywords to any category, built-in or your own. Advanced users can add
  regular-expression rules. Your rules always take priority over built-in ones.
- **Sensible matching:**
  - short keywords match whole words only, so "ola" does not match "Coca Cola";
  - longer keywords also match inside joined-up text, so "amazon" matches "AMAZONPAY";
  - near-misses are caught too, so "ZOMATOO" still lands in Food & Dining.
- **Your own categories:** create categories of type *Expense*, *Income* or *Transfer*, rename them or
  delete them. Transactions in a deleted category become *Uncategorized*. Built-in categories are shared
  and read-only.

### Transactions

- **Browse and search** all transactions, 50 per page, newest first.
- **Filters:** text search (description or remark), category (including *Uncategorized*), debits or credits
  only, and a date range. Filters are kept in the page address, so a filtered view can be bookmarked.
- **Edit inline:** change a transaction's category straight from the list, or open it to edit the date,
  amount, type, description, category and remark.
- **Bulk recategorize:** tick several transactions and assign them one category at once.
- **Add manually:** record cash spending or anything not on a statement.
- **Delete** individual transactions.

### Dashboard

- **Period selector:** this month, last month, last 3 months, last 12 months, this year or all time.
- **Totals:** income, spending, net (income minus spending) and the number of transactions.
- **Income vs spending chart:** month-by-month bars.
- **Spending by category:** your top categories as bars; click one to see its transactions.
- **Budgets this month:** progress bars for each budget, highlighted when over the limit.
- **Recent transactions:** the latest eight.
- **Uncategorized reminder:** a prompt with a link when some transactions still need a category.
- **No double counting:** transactions in *Transfer* categories (credit card bill payments, investments,
  moving money between your own accounts) are left out of income and spending. Without this, paying a card
  bill would count the same spending twice.

### Budgets

- Set a **monthly limit** for any expense category.
- See **spent versus limit** for any month, with overspending highlighted and the amount over shown.
- See the **total budgeted and total spent** for the month.
- Change or remove a budget at any time.

### Informal loans

- Keep a list of **people** (friends, family, colleagues).
- Record money you **lent** to or **borrowed** from them, with a title, amount and date.
- **Log repayments** as they happen. The app shows the amount paid back and what is still outstanding, and
  marks a loan *Settled* once fully repaid.
- **Totals:** how much others owe you and how much you owe.

### EMIs

- Record a loan with its **instalment amount**, **lender**, **frequency** (every N days, weeks, months or
  years) and **first and last instalment dates**.
- For each EMI the app works out the **total number of instalments**, **how many are done**, the **next
  due date** and the **amount still to pay**. Month-end dates are handled correctly: an EMI on the 31st
  falls on the 28th or 29th in February.
- **Summary tiles:** your approximate total monthly EMI outgo and the total remaining across all EMIs.

### Your data, your control

- **Export:** download everything stored about you as a JSON file, including transactions, categories,
  rules, budgets, people, loans, payments and EMIs.
- **Delete account:** permanently removes your account and all of your financial data in one step.

---

## 2. Pages in the app

| Page | What it's for |
|---|---|
| **Home** (`/`) | Public landing page describing the app. |
| **Sign in** (`/login/`) | "Continue with Google". Explains any sign-in error. |
| **Privacy Policy** (`/privacy/`) | What is collected, why, who can see it, and your rights. |
| **Dashboard** (`/app/`) | Totals, charts, budgets and recent transactions. |
| **Transactions** | Search, filter, edit, recategorize, add and delete transactions. |
| **Import** | Read a bank statement, review it and import it. |
| **Budgets** | Set monthly limits and track them. |
| **Categories** | Manage categories and categorization rules. |
| **Loans** | People, money lent or borrowed, and repayments. |
| **EMIs** | Loan instalments, progress and next due dates. |
| **Access** *(owners only)* | Invite people, revoke access, delete accounts. |
| **Audit log** *(owners only)* | Every user's activity, with filters. |
| **Settings** | Your account, your own activity history, export and account deletion. |

The layout works on phones. The sidebar becomes a scrollable top bar on small screens. The app follows
your device's light or dark mode.

---

## 3. Accounts, roles and access

Sign-in is **Google only**. The app never sees or stores a password.

The app is **invite-only and fails closed**: if something is not explicitly allowed, it is refused.

| Role | Who | What they can do |
|---|---|---|
| **Owner** | Emails listed in the `OWNER_EMAILS` server setting | Everything a member can do, plus invite people, revoke access, delete other members' accounts, and read the full audit log. |
| **Member** | Anyone an owner has invited by Google email | Use the app for their own finances and see their own activity history. |
| **Everyone else** | — | Cannot sign in. No account is created for them. |

- **Owners can only be set on the server.** Nothing done inside the app or its database can turn someone
  into an owner.
- **Inviting:** an owner enters a Google email on the Access page, with an optional note. That person can
  sign in from then on.
- **Revoking:** takes effect immediately. The person is signed out everywhere on their next request. Their
  data is kept, so access can be restored later.
- **Deleting a member's account:** removes their access and all of their data permanently. Owners cannot
  delete other owners.
- **Access is re-checked on every request**, not only at sign-in. Removing an email from `OWNER_EMAILS`
  demotes that person straight away.

---

## 4. Privacy

- **Your financial data is visible only to you.** No other member can see it, and **neither can owners**.
  Owners see *activity* (who did what, and when), never transactions, amounts, descriptions, budgets,
  loans or EMIs.
- **Statement files never leave your device.** Only the rows you confirm are saved.
- **Minimal Google data:** only your Google account ID, email, name and profile picture. No access to
  Gmail, Drive, Contacts or anything else.
- **Cookies:** only two strictly necessary ones (staying signed in, and protecting the sign-in step). No
  analytics, advertising or tracking cookies.
- **No selling, no sharing, no ads, no AI training.** Data is only processed by the services that run the
  app: Google for sign-in and Cloudflare for hosting.
- **Full details:** [Privacy Policy](https://pfm.arnavg.me/privacy/).

---

## 5. Security

| Area | Protection |
|---|---|
| **Sign-in** | Google OAuth 2.0 / OpenID Connect with PKCE, `state` and `nonce`. The client secret stays on the server. The Google identity token's issuer, audience, expiry, nonce and verified-email flag are all checked. |
| **Sessions** | 256-bit random tokens. Only a SHA-256 hash is stored in the database, so a database leak does not expose sessions. The cookie uses the `__Host-` prefix and is `HttpOnly`, `Secure` and `SameSite=Lax`, so page scripts cannot read it. Sessions last 14 days and are renewed while in use. |
| **Data isolation** | Every database query is restricted to the signed-in user. The database also enforces ownership (a loan cannot point at another user's person). Built-in categories are read-only. |
| **Cross-site attacks (CSRF)** | Every request that changes data must come from the app's own address, must be JSON, and relies on SameSite cookies. |
| **Injection** | All SQL uses bound parameters. Search text is matched literally. Every input is validated (types, lengths, real calendar dates, at most two decimals for money). |
| **Script injection (XSS)** | The interface never inserts HTML from data; bank descriptions are always shown as plain text. A strict Content Security Policy only allows the app's own scripts, and the site cannot be embedded in other sites. |
| **Transport** | HTTPS only, with HSTS. API responses are never cached. |
| **Money accuracy** | Amounts are stored as whole paise (integers), so there are no rounding errors. |
| **Errors** | Error messages never reveal internal details. |
| **Exposure** | The app is only reachable at its own domain. Cloudflare's default `workers.dev` and preview addresses are switched off. |

These protections are covered by an automated test suite that runs the real API against a local database on
every build, and a failing test blocks the deploy. It checks that:

- no route can be used without signing in;
- members cannot reach owner features;
- users cannot read, change or delete each other's records;
- revoked users are cut off immediately;
- cross-site requests and non-JSON bodies are refused;
- Google sign-in rejects bad, expired or replayed tokens and never creates accounts for uninvited people;
- the audit log cannot be edited and never contains financial details;
- duplicate imports are skipped, and statement parsing handles each known edge case.

---

## 6. Audit log

Every request to the app's API creates one audit entry, including requests that fail or are refused.

- **What is recorded:** time, user, the action taken (for example "Imported a statement"), whether it
  succeeded, failed or was denied, the record affected, IP address, country and browser.
- **What is covered:**
  - signing in, including denied and failed attempts;
  - signing out;
  - every view, create, edit, delete and import;
  - access changes made by owners;
  - blocked requests, such as a member trying to use owner features or a request without a valid session.
- **What is never recorded:** amounts, descriptions, search terms or anything else from your financial
  records. Only safe facts, such as how many rows an import added.
- **Tamper-proof:** the database refuses to edit audit entries, and refuses to delete them unless the
  daily retention job has opened its purge window (no request to the app can do that).
- **Who can see it:**
  - owners see everyone's activity on the **Audit log** page, filterable by person, activity type, result
    and date;
  - every member sees their own activity under **Settings → My activity**.
- **Kept after account deletion** as a security record. It holds no financial data.
- **Retention:** a daily job deletes entries older than 400 days (and the oldest beyond 500,000 entries),
  then records an "old audit entries removed" summary. The same job erases records you deleted more than
  30 days ago (deletes can be undone until then).

---

## 7. How it is built

| Layer | Technology |
|---|---|
| Interface | [Astro](https://astro.build) static pages with small TypeScript scripts (no heavy framework), self-hosted fonts and SVG charts |
| API | [Hono](https://hono.dev) running as a Cloudflare Worker, with input validation by [Zod](https://zod.dev) |
| Database | Cloudflare D1 (SQLite), with schema changes managed as migration files |
| Statement parsing | [SheetJS](https://sheetjs.com), running in the browser |
| Sign-in | Google OAuth |
| Hosting | Cloudflare Workers with static assets, on the custom domain `pfm.arnavg.me` |
| Deployment | Every push to the `main` branch on GitHub is built and deployed automatically |

See [README.md](README.md) for local setup, development, deployment and where to change things.

---

## 8. What is stored

| Data | Contents | Visible to |
|---|---|---|
| Account | Google ID, email, name, picture URL, sign-up and last sign-in time | You; owners see email, name and sign-in times |
| Sessions | Hashed session token and expiry | No one (used only to verify sign-in) |
| Transactions | Date, amount, debit/credit, description, category, bank, account type, last four digits, remark | Only you |
| Categories and rules | Your custom categories and keyword or regex rules | Only you (built-in ones are shared) |
| Budgets | Category and monthly limit | Only you |
| People, loans, repayments | Names, amounts, dates, notes | Only you |
| EMIs | Title, lender, instalment, frequency, dates, note | Only you |
| Access list | Invited emails, who invited them and when, optional note | Owners |
| Audit log | Activity records (see section 6), no financial data | Owners (everyone); you (your own) |

---

## 9. Limitations

- **Supported banks:** HDFC and ICICI statement formats are built in. For other banks, map the columns
  once on the Import page and save the mapping as a format, or enter transactions by hand.
- **Currency:** Indian rupees only.
- **Sign-in:** Google accounts only.
- **No automatic bank syncing:** statements are imported manually.
- **Audit log tamper-proofing** stops every request to the app, but code running inside the Worker
  could still open the purge window. A copy outside the database (for example a nightly export to R2)
  would close that gap; it isn't built.
- **Rate limiting:** not built into the app. It can be added with a Cloudflare firewall rule.
