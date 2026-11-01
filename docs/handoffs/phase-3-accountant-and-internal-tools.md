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
- **Built:**
- **Staff accounts created:**
- **Spreadsheet column mapping for the pilot:**
- **Zoho test organization, and the pilot's category-to-account mapping:**
- **Changes from spec or plan, and why:**
- **Environment variables added:**
- **Known issues and TODOs:**
- **QA results (date, who ran it):**
- **Next session starts with:**
