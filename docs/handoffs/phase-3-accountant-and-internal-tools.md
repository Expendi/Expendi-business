# Phase 3 Handoff: Accountant & internal tools

**Linear:** milestone "Phase 3 · Accountant & internal tools"

- EXP-299 (T22) Monthly export
- EXP-280 (T23) Internal admin app and staff login
- EXP-290 (T24) Companies, payout queue and pause
- EXP-297 (T25) Spreadsheet import
- EXP-291 (T26) Alerts
- EXP-283 (T27) Audit log viewer
- EXP-301 (T30) Zoho Books connection and account mapping
- EXP-302 (T31) Push paid claims to Zoho Books
- EXP-315 (T44) Push other paid spending to Zoho Books

**Goal:**

- the accountant gets a clean monthly export of all money out, plus what's outstanding
- all paid spending (claims, petty cash, bills, company spending, payroll runs) lands in the accountant's Zoho Books on its own
- the Expendi team can run, watch and pause the system from an internal admin app
- problems trigger email alerts

**Can start early:** T23 and T27 only need Phase 0, so they can run alongside Phases 1–2 in a separate session.

## Start prompt

> Read `docs/handoffs/README.md`, the Handoff notes in `docs/handoffs/phase-2-claim-flow.md` and `docs/handoffs/phase-2b-spending-and-payments.md`, then `docs/handoffs/phase-3-accountant-and-internal-tools.md`. Build Phase 3 one task at a time, in the order listed, reading each task's Linear issue first. Stop at Checkpoint D and go through the QA checklist with me.

## Read first

- **Spec:**
  - §6.11 (export), §6.12 (import), §6.13 (audit log)
  - §6.15 (internal admin), §6.16 (alerts), §6.17 (Zoho Books sync)
  - §7 item 6 (payout pause)
  - §10: `staff_users`, `platform_settings`, `import_runs`, `accounting_connections`, `accounting_syncs`
- **Build plan:** Tasks 22–27, 30–31 and 44
- **Spec, for the new kinds of spending the export, import and Zoho sync must handle:** §5 "Kinds of money out", §6.19–6.23
- **Consumer repos:**
  - `recurring-payments-frontend/apps/core-admin/` and `apps/admin/`: the patterns for the Next.js admin apps
  - `backend/src/routes/internal.ts`: the pattern for protected internal routes

## Where things stand

Phases 2 and 2B are done; check their Handoff notes. Everything below works on staging:

- claims
- bills and recurring payments
- salaries and payroll runs
- petty cash floats
- company spending
- the spending overview

## Inputs needed from Dennis

1. **The pilot spreadsheet:** the header and 3 sample rows from each part (petty cash, transactions, salaries, subscriptions), for T25.
2. **The alert email list:** who receives alerts.
3. **DNS access to `expendi.app`**, to add Resend's SPF and DKIM records.
4. **Staff list:** email addresses, and whether each person is `ops_admin` or `ops_viewer`.
5. **Zoho API client:** the ID and secret of a server-based client registered in Zoho's API console with Multi-DC on, stored in Doppler.
6. **A test Zoho Books organization:** a free trial with KES as its currency, for QA.
7. **From the pilot's accountant:**
   - their Zoho expense accounts and the Paid Through account
   - whether posting eTIMS expenses gross works for them
   - how they want salaries posted (one expense per payroll run is proposed)
   - which petty cash and company bank accounts to map (T44)

## Tasks, in order

T23 → T27 → T24 → T22 → T25 → T30 → T31 → T44 → T26

**Notes**

- **T23:**
  - Staff login is separate from customer login, and internal routes live under `/internal/*`.
  - Roles are enforced **in the API**, not only in the UI.
  - Add staff accounts with a script.
- **T27:** read-only search by company, actor, action and date.
- **T24:**
  - **There must be no staff endpoint that creates a payout or a withdrawal.** Add a test that lists every internal route and checks this.
  - Resolving a stuck payout or pausing payouts needs a reason and a second confirmation.
- **T22:**
  - Month boundaries use Africa/Nairobi time.
  - Write the CSV as UTF-8 with a byte-order mark so Excel opens it cleanly. Show amounts in KES, not cents.
  - Receipt files are named `YYYY-MM-DD_employee_merchant_amount.ext`, with a suffix added if two names clash.
  - Send email from `expendi.app`.
  - Cover all money out: claims, petty cash, bills, salaries per person, and company spending. Add a second sheet listing bills that are due or overdue at month end.
- **T25:**
  - Import each part of the sheet:
    - payees, with payment details left unconfirmed until an admin confirms them
    - salaries
    - recurring bills with their next due dates
    - unpaid bills and unpaid claims
    - open floats
    - 3 months of `paid_outside` history
  - Kenyan spreadsheets usually write dates as `DD/MM/YYYY` and amounts like `"1,500.00"`.
  - Do a dry run before any write, and use a hash of each row so a re-run imports nothing new.
- **T30:**
  - The connect link is single-use, expires after 7 days, and is stored only as a hash.
  - Zoho's callback names the user's accounts server, and the token response gives the API domain. Use those for every later call; don't hard-code `zoho.com`.
  - Request only the scopes §6.17 lists, not full access. Check the exact scope names in Zoho's official API docs.
- **T31:**
  - Enqueue the sync wherever a claim moves to `paid` (the webhook and the reconciliation job), in the same transaction.
  - Check the receipt-attach endpoint and its field name in Zoho's official API reference; third-party guides disagree.
  - Convert KES cents to a 2-decimal string for Zoho with integer maths, never floats.
- **T44:**
  - Each payroll run posts **one** Zoho expense for its total. Per-person amounts never go to Zoho.
  - Float issues and top-ups never sync.
  - Add the Paid Through mapping for the petty cash account and the company's bank accounts to the T30 screens.
- **T26:**
  - The low-balance alert counts unpaid claims plus the bills and payroll due in the next 7 days.
  - Deduplicate alerts on alert type plus entity.
  - The reconciliation job records a heartbeat, and the "reconciliation stopped" alert checks it.
  - Include the "Zoho sync failing" alert, using the failures T31 records.

## Environment variables (suggested names)

| Name                                   | Purpose                                        |
| -------------------------------------- | ---------------------------------------------- |
| `RESEND_API_KEY`                       | Email                                          |
| `EMAIL_FROM`                           | e.g. `Expendi Business <no-reply@expendi.app>` |
| `ALERT_EMAILS`                         | Comma-separated alert recipients               |
| Admin app Privy config                 | Staff email login                              |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | Zoho API client                                |
| `ZOHO_REDIRECT_URI`                    | The API's Zoho OAuth callback URL              |
| `ACCOUNTING_TOKEN_KEY`                 | Encrypts stored Zoho refresh tokens            |

## Exit criteria: Checkpoint D

- Go-live checklist items 2–6 (spec §13) pass
- Every kind of paid spending syncs to a test Zoho Books organization (spec §6.17)
- Reviewed with Dennis

---

## QA checklist

**Automated**

- [ ] The export's columns match §6.11, and the zip's filenames match the "receipt file" column
- [ ] An import dry run writes nothing; re-running the same file imports nothing new
- [ ] The `ops_viewer` role is rejected on every action endpoint
- [ ] The route-listing test confirms no staff endpoint can create a payout or withdrawal
- [ ] An open alert sends only one email
- [ ] UPDATE and DELETE on `audit_log` are still rejected
- [ ] A retried Zoho create leaves exactly one expense, and `paid_outside` claims never sync
- [ ] The Zoho refresh token is encrypted at rest and no endpoint returns it
- [ ] The export includes every kind of money out, plus the outstanding-bills sheet
- [ ] A payroll run syncs as one Zoho expense, and float issues and top-ups never sync

**Manual**

- [ ] Export a month:
  - it opens correctly in Excel and Google Sheets
  - KES amounts are right
  - the self-approved column is filled
  - receipt files match the zip
- [ ] The monthly email arrives from `expendi.app`, not in spam, and its link works
- [ ] A non-staff email can't sign in to the admin app. A viewer can look but can't act, including when calling the API directly.
- [ ] Payout queue:
  - a `needs_review` payout shows up
  - re-fetching from Paycrest works
  - resolving it requires a note and a confirmation
  - the resolution is audited
- [ ] Pausing all companies blocks new payouts. Pausing one company blocks only that company. Unpausing works.
- [ ] Import the pilot's sample spreadsheet:
  - review the dry-run report
  - run the import
  - re-running imports nothing new
  - an imported M-Pesa code blocks a new duplicate claim
  - payees, salaries, recurring bills (with their next due dates) and open floats come in correctly, and payees' payment details wait for an admin to confirm them
- [ ] Trigger each of the 6 alerts once: one email each, and resolving clears it
- [ ] The audit log viewer finds staff actions by actor and doesn't allow edits
- [ ] Zoho Books, against the test organization:
  - connect through the emailed link; a used link is refused
  - a non-KES organization is refused
  - map categories, then pay a claim: it appears in Zoho with the right account, amount, reference and receipt
  - revoke access in Zoho: the connection shows `needs_reconnect` and the alert fires
  - reconnect: claims paid in the meantime sync
  - pay a bill, record petty cash and company spending, and pay a payroll run: each appears in Zoho as §6.17 describes

**Hygiene**

- [ ] Build, typecheck and tests pass; no keys committed; no `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] EXP-299, 280, 290, 297, 291, 283, 301, 302 and 315 are Done in Linear
- [ ] Checkpoint D reviewed with Dennis

---

## Handoff notes (fill in before ending each session)

- **Status:**
  - 2026-11-02: started early, in parallel with Phase 2 code (Dennis's decision; see the Phase 2 Handoff notes, "QA deferred").
  - T23 is in progress; T27, T24 and T30 follow it.
  - T22, T25, T26, T31 and T44 wait for T19 and Phase 2B code.
- **Status (2026-11-02, fifth wave):**
  - T22, T31, T44 and T26 code done. T26 includes the admin alerts and system health pages. See `next-session.md` for final release verification and deployment status.
  - T25 (spreadsheet import) is the only Phase 3 task not built; it needs the pilot's spreadsheet sample.
  - Migrations 0057–0064 are applied on dev with release `15978ee`; API health and migration count were verified. The internal admin app is still local-only. A second session's drafts for T22, T31 and T44 (migrations 0057–0058) were taken over and reworked; `0057_salty_bloodstrike` was renamed `0057_accounting_sync_columns` before deployment.
  - Zoho and the monthly export haven't run against real services.
- **Built:**
  - **T22 monthly export (EXP-299):**
    - **Routes:** `GET /organizations/:id/reports/exports` (list; admins and accountants), `POST …/reports/exports {month}` (generate; admins; returns three 30-day links; audited `report_export.generated`), `GET …/reports/exports/:exportId/files/:file` (15-minute R2 link) and the public `GET /downloads/reports/:token/:file` (redirects to a fresh R2 link; 410 expired, 404 invalid or revoked).
    - **Links:** the token is stored hashed. The 30-day link isn't a presigned R2 URL (SigV4 allows 7 days at most).
    - **Job:** `monthly-export` (lock 72_022). On its first run in a new Nairobi month it makes last month's export and emails each non-removed accountant (invited included) their own link, once per company per month. `fflate` was added; the xlsx is written by hand.
    - **Migrations:** `0059_report_exports` and `0060_report_exports_rls`: `report_exports` and `report_export_links` (RLS FORCE, no DELETE; admins and accountants read, admins write), plus the definers `report_export_by_token(hash)` and `monthly_export_companies()`.
    - **App:** `(admin)/export.tsx`.
    - **Gaps:** a receipt missing from R2 fails the whole export (503); if recording a sent email fails, the next run re-sends with a new link; the receipts zip is built in memory (fine at pilot scale).
  - **T31 push paid claims to Zoho (EXP-302):**
    - **Queue:** a claim moving to `paid` queues a sync in the payout's transaction (`claim-payout-hooks.ts` → `services/zoho/enqueue.ts`).
    - **Job:** `zoho-sync` (lock 72_031, every 60 seconds) posts with the mapped account, searches Zoho by reference before every create, and attaches the receipt (`POST /expenses/{id}/receipt`, no new scope needed).
    - **Retries:** 6 tries (1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours), then `failed` and an `accounting_sync.failed` audit entry. Rate limits and paused connections don't use tries. `needs_reconnect` pauses syncing, and the backlog syncs after reconnecting.
    - **Staff:** `GET /internal/companies/:id/zoho/syncs?status=failed|pending|synced` and `POST …/zoho/syncs/:syncId/requeue` (ops_admin, audited `accounting_sync.requeued`), with a "Syncs to Zoho" panel in the admin app.
    - **Migrations:** `0057_accounting_sync_columns` (also T44): `accounting_syncs.external_organization_id` and `next_attempt_at`, `accounting_connections.petty_cash_account_id` and `salaries_account_id`. `0058_zoho_sync_queue`: an owner-read policy on `accounting_syncs` and `accounting_syncs_due(max_rows)`.
    - **Unconfirmed against live Zoho:** the exact-match `reference_number` filter, the amount as a JSON number, "add receipt" when one exists, size limits, and daily call limits (1,000 a day free; 2–4 calls per claim).
  - **T44 push other paid spending to Zoho (EXP-315):**
    - **Queues:**
      - petty cash (float spending, and claims with a float)
      - company spending, through its mapped paid-from account
      - bills paid through Expendi (wallet account, invoice attached, USD at the payout's KES)
      - bills paid outside (once, as the bill, through its paid-from account)
      - each payroll run, as one expense for the total to the salaries account, described "Salaries · payroll run for <pay date>" with no names or per-person amounts
    - **Never synced:** float issues and top-ups, and imported history.
    - **No new migration:** it uses 0057's columns and `paid_from_accounts.accounting_account_id`.
    - **Admin Zoho page:** petty cash Paid Through, salaries account, and a mapping per paid-from account.
    - **Defaults:** bill date is the day paid; payroll run date is the pay date; the invoice is preferred over proof; zero-total runs aren't queued; missing mappings defer with a message.
    - **Confirm against live Zoho:** which Paid Through account types it accepts, PDF receipts, and (with the accountant) payroll on the pay date versus the paid date.
  - **T26 alerts (EXP-291):**
    - **Status:** API and admin pages are built; live QA remains.
    - **Staff reads:** `GET /internal/alerts` and `GET /internal/health`, behind staff login, available to `ops_viewer` and `ops_admin`, read-only. Alerts show open incidents first, then those resolved in the last 7 days, up to 200 with a truncation flag. Health shows the last reconciliation run, its 5-minute overdue status, and the open or latest webhook signature-failure incident.
    - **Admin pages:** `/alerts` and `/health`, linked from staff navigation, refresh every minute. Alerts link to the relevant payout, company, Zoho or health page. Only `reconcile-paycrest` currently records a heartbeat.
    - **Tests:** `internal-alerts.serial.test.ts` covers 20 cases for staff access, viewer access, read-only routes, customer isolation, incident ordering and health. These run serially because alerts and heartbeats are platform-wide. The admin app has no component-test setup.
    - **Job:** `alert-checks` (lock 72_026, every minute), emailing `ALERT_EMAILS`. One open incident per kind and subject (database index), a send lease, a Resend idempotency key and retry backoff.
    - **The 6 alerts:**
      - payout needs review (per payout; resolves when it leaves the state)
      - payout failed (approved, failed in the last 24 hours, once per payout ever)
      - Paycrest webhook signature failure (raised inline; resolves after 60 quiet minutes)
      - reconciliation stopped (heartbeat older than 5 minutes; reconcile now writes a heartbeat)
      - low company balance (spendable below unpaid claims plus 7-day cash-check obligations)
      - Zoho sync failing (`needs_reconnect`, or any failed sync)
    - **Migrations:** `0062_ops_alerts` and `0063_ops_alerts_access`: the `ops_alert_kind` enum, `ops_alerts`, `station_heartbeats`, system-only RLS on alerts, an `expenses_owner_reads` policy, and the definers `ops_alert_payouts`, `ops_alert_balance_companies` and `ops_alert_zoho_companies`.
    - **Migration 0064:** `0064_staff_ops_alerts_reads` adds `staff_ops_alerts(...)` to include company names without extra owner access to `ops_alerts`. Customer and signed-in-user scopes return no rows.
    - **Gaps:** only Paycrest signature failures alert; staff-resolved failed payouts also email; the Zoho alert shows counts, not error text; low-balance shows only the spendable balance; if the whole API is down nothing alerts (needs external uptime monitoring); the first run on deploy emails existing `needs_review` and recently failed payouts once.
  - **T23 (2026-11-02, uncommitted):**
    - **`staff_users`** (migrations 0020/0021). The app role has no grant on the table; staff login resolves only through `active_staff_by_email()` (SECURITY DEFINER), so the API can't list, add or re-enable staff.
    - **`/internal/*`:**
      - staff login on every request (Privy token → email → an active staff row)
      - `requireStaffRole("ops_admin")` for actions
      - `POST /internal/session` audits `staff.signed_in`
      - CORS only for `ADMIN_APP_ORIGINS`
    - **A route-listing test** fails if any internal route could create, approve, fund or retry a payout or withdrawal.
    - **Staff and customer access are independent,** tested with one login that is both.
    - **`apps/admin`:** Next.js 16 with Privy email login, copied from the consumer `apps/admin`.
    - **`scripts/add-staff.ts`:** run it with `SECRETS_MANAGER=env DATABASE_URL_MIGRATE=<owner url>` (with `doppler`, Doppler's values would overwrite the URL you pass).
  - **T27, audit log viewer:** `GET /internal/audit` (company, actor, action prefix, entity, Nairobi date range; keyset paging) through `staff_search_audit_log()`. The app role still has no SELECT on `audit_log`.
  - **T24, ops console:**
    - **Company reads:** one company's view runs in that company's scope inside a `READ ONLY` transaction. Lists that span companies use SECURITY DEFINER functions.
    - **Two-step confirmations:** `staff_confirmations` (migration 0036) stores single-use, 5-minute tokens, hashed and bound to the purpose, target, parameters and staff member.
    - **Resolving a `needs_review` payout:**
      - **`paid`** needs Paycrest `validated`/`settled` (an on-chain deposit only proves Paycrest received the USDC). For an on-chain payout it needs the exact transfer.
      - **`failed`** needs no transfer, funding at least 30 minutes ago, and the order expired or cancelled.
      - A missing debit is recorded exactly once.
    - **Pause:** platform-wide through `set_platform_payouts_paused()`; per company through the company's own scope. Both are audited.
    - **Money guard:** the route-listing test now also checks the import graph: nothing under `/internal` can reach the approve, fund, prepare, retry or send code.
  - **T30, Zoho connection:**
    - **Tables:** `accounting_connections` + `accounting_syncs` (migrations 0028/0029).
    - **Token storage:** refresh tokens sealed with AES-256-GCM, `v1:<keyId>:<iv>:<tag>:<ct>`, the connection ID bound as additional data, and canonical base64url enforced.
    - **Connect link:** single-use, lasts 7 days, stored hashed. The OAuth `state` is HMAC-signed.
    - **Zoho's servers:** the `accounts-server` named in the callback and the `api_domain` are both checked against Zoho's hosts.
    - **Scopes:** `ZohoBooks.settings.READ`, `ZohoBooks.accountants.READ`, `ZohoBooks.expenses.CREATE` and `ZohoBooks.expenses.READ`.
    - **A dead refresh token** shows up as `invalid_code` (as well as `invalid_grant` or 401) and sets `needs_reconnect`.
- **Staff accounts created:**
  - Staff list (Dennis, 2026-11-02): `hello@cradlelabs.io` as `ops_admin`. It is added with `scripts/add-staff.ts` once T23 is deployed.
  - The same email is also the customer admin of the dev test company "Expendi Test Co", so staff and customer access must stay independent (tested in T23).
- **Spreadsheet column mapping for the pilot:**
- **Zoho test organization, and the pilot's category-to-account mapping:**
- **Changes from spec or plan, and why:**
  - **T22 (spec §6.11 updated):**
    - The CSV download is a zip of three CSVs, and each month has three links (workbook, CSV zip, receipts). Reason: one month has several sheets, and CSV has one table per file.
    - Each accountant gets their own link, which stops working when they're removed; an admin's export has one shareable link. Reason: a removed accountant must lose access.
    - Self-approved is filled only for claims (No for bills and salaries), and company spending leaves "Payee or employee" blank. Reason: neither has an approver or a payee in the data.
    - Dennis approved the third sheet "Float transfers" on 2026-11-02; spec §6.11 records it. Float issues and top-ups move money rather than count as spending.
  - **T31 (spec §6.17 updated):**
    - Only companies with a connection that isn't disconnected queue syncs, so nothing from before connecting is pushed. Reason: history is already in the books.
    - The job searches Zoho by reference before every create, not only before a retry. Reason: it removes the duplicate risk on a first call that timed out.
    - The description is cut to Zoho's 100 characters, keeping name, M-Pesa code, eTIMS invoice number and PIN. A sync is tied to the Zoho organization of its first try.
    - JPEG, PNG, GIF, BMP and PDF receipts attach; WebP and HEIC post without a receipt. Confirm PDF attachment support against live Zoho.
  - **T44:** Dennis approved posting overspend claims through the Expendi wallet account on 2026-11-02, because the wallet paid the extra. Spec §6.17 records it; confirm with the accountant during live QA.
  - **T26 (spec §6.16):** the admin Alerts and System health pages completed after the API and email work; both are read-only, preserving the rule that staff never move company money.
- **Environment variables added:**
  - **API (fifth wave):**
    - `API_PUBLIC_URL` (T22): the API's public address, used for export links. Without it, generating answers 503 and the monthly job fails.
    - `ALERT_EMAILS` (T26): comma-separated. Without it, alerts are only logged.
  - **API:** `ADMIN_APP_ORIGINS`, optional and comma-separated.
  - **Admin app:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_PRIVY_CLIENT_ID` (optional).
  - **API, Zoho, all optional (without them, connect answers 503):** `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI`, `ACCOUNTING_TOKEN_KEY` (`openssl rand -base64 32`; never change it once tokens are stored).
  - **Zoho console:** a server-based client, redirect `<api>/integrations/zoho/callback`, Multi-DC on with "same credentials for all data centres".
  - **Privy dashboard:** add the admin app's origins (e.g. `http://localhost:3001` and the deployed URL) as allowed domains.
- **Known issues and TODOs:**
  - **T25** isn't built; it needs the pilot's spreadsheet sample.
  - **T26:** admin pages are built; configure `ALERT_EMAILS` and run the live checks, including the operational gaps above.
  - **T22 export recipients:** done (invited accountants are included).
  - **Zoho:** the unconfirmed behaviours under T31 and T44 need a live check.
- **QA results (2026-11-02, OpenCode):** final API suites passed 2,044 main and 169 serial tests on a fresh local database through migration 0064; no schema drift. API/shared checks and admin build pass. Fixed the staff-health test's fixture cleanup to age both open and resolved webhook incidents left by earlier serial files; a deterministic regression failed before the fix and passes after it. Live provider and Checkpoint D QA remain pending. See `next-session.md` for the complete release results.
- **Next session starts with:** finish R2 CORS and Resend DNS setup, configure Zoho, and verify alert delivery to the now-configured `ALERT_EMAILS`. See `next-session.md` for release status. T25 still needs the pilot spreadsheet.
