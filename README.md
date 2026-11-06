# Expendi Business

B2B stablecoin finance for African startups. The current Kenya MVP brings staff claims, petty cash, supplier bills, subscriptions and salary payments into one workspace, with mobile, customer web and internal operations apps.

Companies hold USDC on Base in wallets managed by Expendi. The payment engine supports KES payouts to M-Pesa numbers, Tills, Paybills and Kenyan bank accounts, plus USDC wallet transfers. Staff claims currently reimburse to verified M-Pesa numbers; payroll currently pays fixed net salaries in KES.

## Status

_Last reviewed against source code and recorded handoffs: 2026-11-03._

**The Kenya spending MVP is implemented through Phase 3B. Pilot acceptance testing and distribution remain pending.** The full platform in the [implementation guide](docs/implementation-guide.md) still needs customer invoicing, advanced expense management and global contractor/employee payroll.

“Implemented” means code exists, not that every real-provider or device acceptance check has passed. Deployment and test results below are recorded evidence from prior sessions, not checks rerun for this README update.

### Current MVP build status

These phase numbers belong to the [51-task MVP build plan](docs/expense-mvp-build-plan.md); the original implementation guide has a different six-phase roadmap.

| MVP phase                       | Implemented scope                                                                           | Acceptance status                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0 · Foundation                  | Monorepo, API, company isolation, audit log, authentication                                 | Foundation QA recorded as passed                                      |
| 1 · Money path                  | Wallets, deposits, Paycrest, payout engine, refunds, USDC transfers                         | Checkpoint B's Phase 2 live-money gate passed; Phase 2B gate pending  |
| 2 · Claim flow                  | Mobile app, onboarding, invites, claims, receipt capture/reading, eTIMS evidence, approvals | Implemented; Checkpoint C pending; AI receipt reading disabled        |
| 2B · Spending & payments        | Payees, bills, recurring payments, net salaries, petty cash, company spending, overview     | Implemented; Checkpoint C2 pending                                    |
| 3 · Accountant & internal tools | Exports, Zoho Books, Ops app, imports, alerts, audit viewer                                 | Implemented and deployed; Checkpoint D and client import QA pending   |
| 3B · Web dashboard              | Admin/accountant dashboard, batch approvals, payments, reports and settings                 | Implemented and deployed; authenticated browser Checkpoint D2 pending |
| 4 · Pilot launch                | EAS production build, submission and OTA tooling                                            | T28 store/device acceptance and T29 pilot go-live pending             |

### Recorded deployment and verification

- Customer dashboard: <https://business.expendi.app>. Internal Ops: <https://expendibiz-admin.expendi.app>. The API is deployed to Railway's **dev** environment.
- Latest documented release: customer import supplier/category creation (`4e92491`, 2026-11-03), plus Ops build-order fix (`3b87e3d`). API and both web deployments succeeded; migrations through `0066` were previously verified. See the [customer import runbook](docs/runbooks/customer-imports.md).
- The 2026-11-02 combined verification recorded **2,812 passing tests**, all 20 typecheck/lint/format tasks, and API/admin/web builds. Later importer releases have their own targeted checks; the latest recorded 43 API, 162 web and 187 shared tests plus release builds/typechecks and mocked-browser smoke tests. See [release verification](docs/work/import-auto-create/delivery.md).
- Real-device/provider QA is still largely outstanding. No live client records were imported during the importer releases, and pilot go-live has not been recorded.

## What is implemented

### Platform, identity and access

- Turbo + pnpm monorepo; Hono + Effect API; Postgres + Drizzle; shared validation and types.
- Company-scoped row-level security, restricted database roles, transaction-scoped identity and append-only audit records.
- Privy email-code and passkey sign-in, company creation with KRA PIN validation, invitations, member removal and company switching.
- Admin, employee and read-only accountant roles. Accountants can view salaries and reports; company write routes reject accountant access.
- Doppler secrets, R2 document storage integration, Resend email, Telnyx phone verification and Expo push integrations.

### Wallets and payments

- One managed Privy wallet per company, Base USDC deposit detection through Alchemy, ledger/history and KES balance estimates.
- Shared payout engine for claims, bills, floats and payroll: batch-bound passkey approval, balance reservation, daily/payroll caps, company/global pauses and idempotent funding.
- Paycrest KES payouts, exact USDC transfers, passkey-protected withdrawal allowlists, signed webhooks, reconciliation, onchain confirmation, refunds and explicit retries. Uncertain outcomes enter `needs_review`.

### Claims, receipts and expense evidence

- Expo/React Native app with employee claim creation, editing, submission, rejection/resubmission, payment status and admin approval screens.
- Receipt photos/screenshots, compressed uploads, M-Pesa SMS parsing, manual entry and receipt downloads.
- Claude-based receipt extraction with structured pre-fill and manual fallback. **Implemented but disabled in the deployed environment at Dennis's request**; labelled-receipt evaluation remains deferred.
- Duplicate protection for receipt files, M-Pesa codes and eTIMS invoice numbers; near-duplicate and older-than-60-days warnings; evidence required for submission.
- eTIMS/TIMS QR parsing, supplier PIN/invoice-number capture, receipt status and an accountant eTIMS report.
- Single-admin Approve & pay, rejection reasons, self-approval audit flags, failed-payment retry and web batch approval of up to 20 claims with one passkey.

Source: [`services/expenses`](apps/api/src/services/expenses), [`services/extraction`](apps/api/src/services/extraction), [`apps/mobile/src`](apps/mobile/src).

### Business spending and salary payments

- Payees with supported payment methods, confirmation of payment-detail changes, admin emails and a second confirmation for payments within the 24-hour change window.
- KES and USD-denominated supplier bills, invoice attachments (including desktop PDF uploads), batch payments and recording bills paid outside Expendi.
- Fixed/variable recurring spending, schedules, pause/resume/end, generated bills and due-date reminders.
- Fixed monthly **net-pay** salary schedules, automatic draft payroll runs, adjustments with reasons, one-off payments, passkey approval, payroll caps, large-salary splitting and individual failure/retry tracking. Employees can view their own salary payments.
- Petty cash floats, issue/top-up, purchase recording, returns, closure/write-off and reimbursement claims for overspending.
- Company spending paid outside Expendi, paid-from accounts, spending overview, upcoming obligations, seven-day cash check and low-balance notifications.

Source: [`services/bills`](apps/api/src/services/bills), [`services/recurring`](apps/api/src/services/recurring), [`services/payroll`](apps/api/src/services/payroll), [`services/floats`](apps/api/src/services/floats), [`services/overview`](apps/api/src/services/overview).

### Accounting, imports and operations

- Monthly workbook, zipped CSVs, receipt archive and eTIMS CSV; shareable expiring downloads and monthly accountant emails.
- Zoho Books connection, encrypted tokens, account mapping, paid-spending sync, receipt attachments, reconnect handling and staff requeue tools. Live Zoho acceptance remains pending.
- Ops imports for payees, salaries, recurring items, unpaid bills/claims, opening floats and paid history.
- Customer-admin CSV/TSV imports for paid expenses and unpaid bills: column mapping, exact-total preview, optional creation of missing suppliers/categories on confirmation, duplicate protection and import history. Historical date cutoff removed; imports do not send money. Imported paid history does not queue Zoho syncs.
- Staff-only Ops dashboard: company inspection, payout review/re-fetch/resolution, pause controls, audit search, exports, imports, Zoho sync status, alerts and system health. Staff cannot initiate company payouts.
- Customer Next.js dashboard: expenses, approvals, bills, recurring items, payees, payroll, wallet, team, categories, activity, reports and imports; read-only accountant access.

Source: [`services/export`](apps/api/src/services/export), [`services/zoho`](apps/api/src/services/zoho), [`services/import`](apps/api/src/services/import), [`apps/admin`](apps/admin), [`apps/web`](apps/web).

## How it fits together

_Drawn from the source code on 2026-11-06, with API migrations through `0066`. Only implemented code is shown, and anything switched off or not wired yet is marked. Each diagram is a PNG in [`docs/architecture`](docs/architecture); click one to open it full size. The Mermaid source for each is in [`docs/architecture/src`](docs/architecture/src). To redraw one after editing it, run `npx -y @mermaid-js/mermaid-cli -i docs/architecture/src/<name>.mmd -o docs/architecture/<name>.png -w 1600 -s 2 -b white`._

1. [Platform](#platform): the apps, the API, providers, jobs and data
2. [Money path](#money-path): wallets, deposits, Approve & pay, payouts, withdrawals
3. [Spending](#spending): sign-up, claims, payees, bills, payroll, floats, overview
4. [Records and operations](#records-and-operations): notifications, exports, Zoho, imports, alerts, Ops app
5. [Apps](#apps): sign-in, mobile screens, web pages
6. [Not wired yet](#not-wired-yet)

### Platform

#### System overview

All four apps import `packages/shared` (zod schemas, types, parsers and money helpers), so the clients and the API validate the same shapes.

![System overview](docs/architecture/01-system-overview.png)

#### Request pipeline

![Request pipeline](docs/architecture/02-request-pipeline.png)

#### API boot

![API boot](docs/architecture/03-api-boot.png)

#### Service layers

All services live in `apps/api/src/services/` and are wired as Effect layers in `layers/main.ts`. Routes and jobs call domain services; anything that moves money goes through the one payout engine.

![Service layers](docs/architecture/04-service-layers.png)

| Service              | Depends on                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expenses`           | payments, payout, phone-verification (payout-phone gate), notification, zoho, FileStorage, ReceiptExtractor, audit                                |
| `bills`              | payees, recurring, payments, payout, expenses (bills paid outside), payroll (run status), notification, zoho, FileStorage, Paycrest (rate), audit |
| `recurring`          | bills and payees tables (next bill), audit                                                                                                        |
| `payroll`            | bills, recurring, payments, payout, approval (salary and margin changes), notification, zoho, EmailSender, audit                                  |
| `floats`             | payout, wallet, phone-verification, expense rules, notification, zoho, audit                                                                      |
| `payees`             | approval, allowlist, phone-verification, Paycrest (bank list), EmailSender, audit                                                                 |
| `withdrawal`         | payout, wallet, Paycrest                                                                                                                          |
| `organization`       | wallet, audit                                                                                                                                     |
| `membership`         | EmailSender, config (install URL)                                                                                                                 |
| `phone-verification` | OtpProvider (Telnyx), EmailSender, audit                                                                                                          |
| `overview`           | wallet ledger, Paycrest (rate)                                                                                                                    |
| `payments`           | payout, wallet, Paycrest                                                                                                                          |
| `payout`             | approval, allowlist, wallet, chain, Paycrest, PrivyWallets, BaseRpc, subject hooks (expenses, bills, floats), audit                               |
| `approval`           | approval settings, auth (recent sign-in), EmailSender, audit                                                                                      |
| `allowlist`          | approval, audit                                                                                                                                   |
| `wallet`             | PrivyWallets, AlchemyWebhook, BaseRpc, Paycrest Gateway (refund detection), audit                                                                 |
| `notification`       | PushSender, EmailSender, overview (cash check for reminders)                                                                                      |
| `zoho`               | Zoho client, Zoho access-token cache, AccountingTokenKey, FileStorage, audit                                                                      |
| `export`             | FileStorage, EmailSender, audit                                                                                                                   |
| `import`             | shared spreadsheet parser, payees/floats/expenses/bills/recurring tables, audit                                                                   |
| `alerts`             | EmailSender, overview (cash check), Paycrest (rate)                                                                                               |
| `staff`              | PrivyAuth, payout, alerts, wallet, chain, Paycrest, BaseRpc, audit                                                                                |
| `auth`               | PrivyAuth, membership (invite activation), audit                                                                                                  |
| `audit`              | Postgres only                                                                                                                                     |

#### Service dependencies: provider clients

![Service dependencies: provider clients](docs/architecture/05-service-dependencies-provider-clients.png)

#### Background jobs (station)

Every API instance runs each job on an in-process interval; a Postgres advisory lock lets only one instance do the work per tick. Postgres tables are the queues.

![Background jobs (station)](docs/architecture/06-background-jobs.png)

#### Data model and isolation

Migrations run as the owner role before each Railway deploy (`apps/api/drizzle`, latest `0066`). The API connects as `expendi_business_app`, which can't bypass RLS.

![Data model and isolation](docs/architecture/07-data-model-and-isolation.png)

### Money path

#### Company wallet creation

![Company wallet creation](docs/architecture/08-company-wallet-creation.png)

#### Deposits and refunds coming in

![Deposits and refunds coming in](docs/architecture/09-deposits-and-refunds-coming-in.png)

#### Wallet ledger

![Wallet ledger](docs/architecture/10-wallet-ledger.png)

#### Approve & pay (claims, bills, floats, payroll, withdrawals)

Every money action uses the same engine. Claims, bills, floats and payroll runs plug in through subject hooks; payroll payments are bills linked to a run.

![Approve & pay (claims, bills, floats, payroll, withdrawals)](docs/architecture/11-approve-and-pay.png)

#### Paycrest order safety checks

![Paycrest order safety checks](docs/architecture/12-paycrest-order-safety-checks.png)

#### Payout states

![Payout states](docs/architecture/13-payout-states.png)

#### Withdrawals and the address allowlist

![Withdrawals and the address allowlist](docs/architecture/14-withdrawals-and-the-address-allowlist.png)

#### Passkey enrolment

![Passkey enrolment](docs/architecture/15-passkey-enrolment.png)

### Spending

#### Company sign-up, team and payout phones

![Company sign-up, team and payout phones](docs/architecture/16-company-sign-up-team-and-payout-phones.png)

#### Staff claims

![Staff claims](docs/architecture/17-staff-claims.png)

![Staff claims — states](docs/architecture/18-staff-claims-states.png)

#### Payees and change protection

![Payees and change protection](docs/architecture/19-payees-and-change-protection.png)

#### Bills and recurring payments

![Bills and recurring payments](docs/architecture/20-bills-and-recurring-payments.png)

![Bills and recurring payments — states](docs/architecture/21-bills-and-recurring-payments-states.png)

#### Salaries and payroll runs

![Salaries and payroll runs](docs/architecture/22-salaries-and-payroll-runs.png)

![Salaries and payroll runs — states](docs/architecture/23-salaries-and-payroll-runs-states.png)

#### Petty cash floats

![Petty cash floats](docs/architecture/24-petty-cash-floats.png)

#### Spending overview

![Spending overview](docs/architecture/25-spending-overview.png)

### Records and operations

#### Notifications

![Notifications](docs/architecture/26-notifications.png)

#### Accountant exports

![Accountant exports](docs/architecture/27-accountant-exports.png)

#### Zoho Books sync

![Zoho Books sync](docs/architecture/28-zoho-books-sync.png)

![Zoho Books sync — states](docs/architecture/29-zoho-books-sync-states.png)

#### Spreadsheet imports

![Spreadsheet imports](docs/architecture/30-spreadsheet-imports.png)

#### Alerts and audit

![Alerts and audit](docs/architecture/31-alerts-and-audit.png)

#### Ops app (apps/admin)

Staff sign in with Privy; the API accepts them only if their email is an active `staff_users` row. `ops_viewer` can read everything, and only `ops_admin` can act. Risky actions need a second confirmation: same staff member, same intent, five minutes, single use.

![Ops app (apps/admin)](docs/architecture/32-ops-app.png)

#### Staff payout resolution

![Staff payout resolution](docs/architecture/33-staff-payout-resolution.png)

### Apps

#### Sign-in and company selection

![Sign-in and company selection](docs/architecture/34-sign-in-and-company-selection.png)

#### Mobile app (apps/mobile)

![Mobile app (apps/mobile)](docs/architecture/35-mobile-app.png)

#### Claim capture on the phone

![Claim capture on the phone](docs/architecture/36-claim-capture-on-the-phone.png)

#### Web dashboard (apps/web · business.expendi.app)

![Web dashboard (apps/web · business.expendi.app)](docs/architecture/37-web-dashboard.png)

### Not wired yet

These came up while mapping the code for the diagrams above.

- **Payout phone confirmation has no screen.** The API has `/me/payout-phone`, `/resend` and `/confirm`, but neither the mobile app nor the web dashboard calls them. Claim payouts, floats and employee payees all require a confirmed number.
- **Receipt reading is off.** It's implemented, but every receipt comes back unread until `ANTHROPIC_API_KEY` is set, and it isn't set in the deployed environment.
- **Bill invoices aren't read.** Invoice uploads work; reading an invoice and its eTIMS QR code isn't wired to bills yet (`services/bills/files.ts`).
- **Some areas are mobile-only or web-only.** The web dashboard has no claim submission, petty cash floats or company spending pages. Category management and imports are web-only.
- **Optional providers fail quietly.** Without the R2 settings, uploads return 503. Without Telnyx, payout phones can't be confirmed. Without Resend, every email fails cleanly. Without `ALERT_EMAILS`, alerts are only logged.
- **System health shows one job.** Only `reconcile-paycrest` records a heartbeat, so the Ops health page lists just that job.

## Pending to complete the current MVP

### 1. Provider setup and acceptance testing

- [ ] Finish/verify R2 browser-upload CORS, Resend DNS and delivery, Telnyx verification, Privy native/browser passkeys, and FCM/APNs credentials and push delivery.
- [ ] Complete Checkpoint B's Phase 2B gate: real Till, Paybill, bank and USDC payments, payroll-cap rejection, fee-buffer calibration and settlement timings.
- [ ] Run Checkpoints C and C2 on real phones: onboarding, claims, uploads, exact payouts, notifications, payee-change protection, recurring bills, three-person payroll and a complete petty-cash cycle.
- [ ] Run Checkpoints D and D2: real staff/admin/accountant access, payout resolution and pauses, exports, alerts, browser uploads/passkeys and batch payments.
- [ ] Configure a Zoho API client/test KES organization and obtain accountant-approved mappings; validate all spending types, attachment support, reconnect/backlog behavior and salary posting dates against live Zoho.
- [ ] Obtain populated pilot exports and real M-Pesa SMS examples; review import mappings and totals with the founder. The supplied Shanga files contained templates/summary data, not populated expense records.
- [ ] If AI receipt reading is enabled later, obtain approval, restore configuration and evaluate against labelled Kenyan receipts before accepting it as complete.

Detailed procedures and outstanding checks: [next-session handoff](docs/handoffs/next-session.md), [customer imports](docs/runbooks/customer-imports.md), [Shanga import preparation](docs/runbooks/shanga-import.md). Newer release notes supersede older “not deployed” notes in the handoffs.

### 2. Open implementation gaps to resolve or explicitly accept

The handoffs record these follow-ups in the implemented MVP:

- **Payment completeness:** persist Paycrest funding transaction hashes; handle oversized non-payroll bills; notify other admins about withdrawals and allowlist changes; improve refund-to-payout matching in remaining corner cases.
- **Payroll:** prevent ending/recreating a salary for the same pay date from drafting the person twice; tighten employee-scope visibility of payroll amounts in the wallet ledger.
- **Overview and notifications:** account for fees/whole-shilling rounding in cash forecasts; improve unknown-amount handling; add bill/float payout-failure notifications and notification navigation beyond claims.
- **Exports and Zoho:** improve missing-receipt export handling and email delivery deduplication; decide first-connect historical backfill; close attachment-format gaps and confirm live provider assumptions.
- **Operations and UI:** add external uptime monitoring and wider job heartbeat coverage; address the documented expense-filter, payment-day FX, company-editing, wallet QR and export-history gaps.
- **Receipt processing:** handle extraction completing after submission and review one-sided near-duplicate warnings.

See [known issues and open decisions](docs/handoffs/next-session.md#7-known-issues-and-open-decisions) for the full recorded list and context.

### 3. Distribution and pilot launch

- [ ] Finish production artwork/configuration and credentials, choose pilot platforms, distribute through Play testing/TestFlight and prove an OTA update reaches installed apps (T28).
- [ ] Complete production hosting/environment setup, including the recorded Vercel plan follow-up and Railway configuration migration.
- [ ] Agree post-pilot pricing; fund and configure the pilot company; invite staff/accountant; import and verify payees, salaries, recurring bills and history; freeze the old spreadsheet at cutover.
- [ ] Obtain accountant acceptance of exports and Zoho postings; pay the first real pilot claim and record its settlement (T29).
- [ ] Complete the first 30 days of operations and success measurement.

Runbooks: [pilot release](docs/runbooks/pilot-release.md) and [pilot launch checklist](docs/handoffs/phase-4-pilot-launch.md).

## Planned after the MVP: USD accounts and company cards

Added to the [MVP spec's roadmap](docs/expense-mvp-spec.md#later) on 2026-11-06; neither is in the implementation guide. Both need answers from the provider before building. The questions are listed in the spec's [To settle](docs/expense-mvp-spec.md#to-settle) section.

- [ ] **USD bank accounts (Polygon Open Money Stack):** each company gets its own US account details, and ACH and wire deposits arrive in its wallet as USDC.
  - **Where:** Polygon blocks Kenya for bank-rail flows, checking the company's address and its owners' addresses. This launches for companies outside Kenya and reaches Kenya if Polygon lifts the block. Nigeria, Ghana, Uganda, Tanzania, Rwanda, South Africa, Zambia, Egypt and Morocco aren't on Polygon's blocked lists.
  - **In the product:** the company's country decides whether an admin sees the USD account option.
  - **To confirm:** deposits settling as USDC on Base, fees, and early access.
- [ ] **Company cards (Lithic):** virtual and physical staff cards with per-card limits, funded from the company's USDC.
  - **Funding:** through Lithic's stablecoin pilot (USDC on Base), or by approving each card payment against the company wallet in real time.
  - **What it unlocks:** paying card-only subscriptions, and the card-transaction linking listed under Part 1 below.
  - **Money safety:** staff pay without an admin passkey for each payment, so cards need their own named purpose and limits in the spec's [money-safety rules](docs/expense-mvp-spec.md#7-money-safety).
  - **To confirm:** issuing to Kenyan companies and staff, and pricing.

## Pending to complete the full implementation guide

The [MVP spec](docs/expense-mvp-spec.md) defines today's agreed scope. The following items cover the broader guide's remaining capabilities, including features deliberately deferred from the MVP. Current bills handle supplier payments; customer sales invoicing requires a new product flow. Current eTIMS support captures expense evidence; issuing KRA tax invoices requires the integration below.

### Part 1 · Full expense management — partially implemented

Existing claims, receipt capture, basic rules, approvals and payouts provide the foundation. Remaining work from [Part 1](docs/implementation-guide.md#system-architecture-overview):

- [ ] **Richer expense records:** original currencies and historical FX/USD normalization, tags, billable/reimbursable flags, merchant details, card linkage and spending-bucket linkage where required.
- [ ] **Expense reports:** named groups of expenses, add/remove expense actions, report submission, aggregate totals, approval history and report-level reimbursement tracking. Existing `/reports` routes generate accounting exports.
- [ ] **Configurable approvals:** submit-and-close/approve/advanced modes, manager chains, threshold escalation, category/tag approvers, forward/return-for-correction actions, auto-approval and random audit sampling.
- [ ] **Configurable policy engine:** member spending limits, category budgets, receipt thresholds, expense-age and merchant restrictions, custom prioritized rules, warning/blocking severity and policy administration/evaluation APIs. Current duplicate/evidence rules and payout caps cover only part of this.
- [ ] **Layered receipt pipeline:** preprocessing/template parsers, dedicated OCR provider integration, confidence-based OCR/LLM/manual-review routing, richer line-item/tax extraction and category suggestions. The current implementation uses a direct Claude pre-fill call with user review.
- [ ] **Additional ingestion:** forwarded email receipts and automatic corporate-card transaction imports/linking.
- [ ] **Broader reimbursement choices:** employee-selected stablecoin/bank/mobile-money destinations and currencies beyond the current claim-to-M-Pesa flow.
- [ ] **Additional integrations:** QuickBooks, Xero, bank export formats and outbound integration webhooks beyond the current Zoho/CSV exports.

### Part 2 · Crypto invoicing — not implemented

Wallet deposits, supplier bill attachments and recurring outgoing payments are reusable foundations. The [customer invoicing system](docs/implementation-guide.md#part-2-crypto-invoicing-acctual-inspired) still needs:

- [ ] **Data model and builder:** clients, invoice numbering, itemized charges, taxes/discounts, currencies, branding, terms and due dates; draft/sent/viewed/partial/paid/overdue/cancelled/refunded lifecycle.
- [ ] **Delivery and client portal:** send, duplicate, cancel and remind actions; public payment links, invoice viewing and payment-method selection.
- [ ] **Payment acceptance:** expiring FX/fee quotes, invoice-specific crypto addresses and QR instructions, fiat virtual accounts/bank references, card checkout and mobile-money collections.
- [ ] **Payment matching and settlement:** invoice-linked incoming payment detection, confirmations, partial payments, receipts, conversion/swaps and settlement to the company's chosen wallet/bank/mobile-money destination.
- [ ] **Additional assets/rails:** USDT/DAI and the required additional fiat currencies/chains; the current engine operates on Base USDC and Kenyan payout rails.
- [ ] **Automation and reconciliation:** recurring customer invoices, automatic sending and overdue reminders, accounting sync and receivables reports.
- [ ] **API and UI:** invoice/client CRUD, public payment options/initiation, recurring-invoice endpoints and collection-provider webhooks, with tenant isolation and end-to-end tests.

### Kenya eTIMS invoice issuance — not implemented

To complete the guide's [DigiTax integration](docs/implementation-guide.md#kenya-etims-tax-integration):

- [ ] DigiTax sandbox/production onboarding, credentials and organization configuration.
- [ ] Item catalog registration with KRA classification, unit and tax codes.
- [ ] Sale/invoice submission, KRA receipt identifiers/signatures, generated QR/verification links and invoice status tracking.
- [ ] Credit notes/cancellations, callbacks, offline handling and failed-submission retry.
- [ ] Daily/failure reports, submission audit history and sandbox/live end-to-end validation.

### Part 3 · Contractor and employee payroll — partially implemented

The current salary feature is a fixed monthly KES **net-payment workflow** with batch approval and individual payout tracking. To complete [Part 3](docs/implementation-guide.md#part-3-payroll-system-deel-inspired):

- [ ] **Contractor management:** worker profiles, country/department/role data, onboarding portal, hourly/fixed/milestone compensation, payment frequencies, payment preferences and contractor invoicing.
- [ ] **Contracts and documents:** country-specific templates, generation, e-signatures, amendments, lifecycle tracking and worker tax-document storage.
- [ ] **Employee records:** employment details, tax/statutory identifiers, effective-dated compensation, allowances and leave/termination states.
- [ ] **Gross-to-net calculations:** base pay, allowances, bonuses/overtime, other deductions, employer contributions and country-specific tax engines for Kenya, Nigeria, Ghana and South Africa. Validate current rules rather than copying the guide's historical tax examples.
- [ ] **Global payouts:** salary/contractor stablecoin preferences, additional currencies/countries/providers, payment-method grouping and efficient onchain batch transfers. Existing payroll rejects USDC payees and uses separate KES payouts.
- [ ] **Payslips and tax reporting:** generated/delivered payslip PDFs, employee downloads, P9A/P10 and other country documents, contractor statements, year-end aggregation and employer-cost/compliance reports.
- [ ] **Supporting API and UI:** onboarding, contracts/signing, calculations, payslips, tax documents and workforce reporting.

### Part 4 · Platform completion and scale — partial foundation

Identity, wallets, storage, notifications, audit, reports and all three apps already exist. The guide's [final roadmap phase](docs/implementation-guide.md#phase-6-polish--scale-weeks-33-40) still needs:

- [ ] Shared invoice/contractor/tax services integrated with existing company access, audit, payments and accounting.
- [ ] Advanced cross-product analytics and reporting, additional-country support and a supported third-party integration API/webhook surface.
- [ ] Verified iOS/Android distribution and device coverage, broader operational monitoring, capacity/load testing and performance work for thousands of customers.

**Suggested completion order:** finish MVP acceptance and launch → customer invoicing with eTIMS issuance → contractor onboarding/contracts and global payments → employee tax calculations/payslips/documents → advanced expense workflows and platform scale. Expand the guide's remaining work into new tasks; completing the current 51-task MVP plan does not complete the full guide.

## Repository layout

| Path              | Purpose                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `apps/api`        | Hono + Effect API, Drizzle schema/migrations, integrations and scheduled jobs |
| `apps/mobile`     | Expo/React Native app for company admins and employees                        |
| `apps/web`        | Next.js customer dashboard for admins and accountants (local port 3002)       |
| `apps/admin`      | Next.js internal operations dashboard (local port 3001)                       |
| `packages/shared` | Shared schemas, types and business/display helpers                            |
| `tooling`         | Shared TypeScript, ESLint and Prettier configuration                          |
| `docs`            | Specs, build plan, decisions, handoffs and operational runbooks               |

## Development

Requires Node 22.21+ within Node 22, pnpm 10.19+ within pnpm 10 (`corepack enable`), and a local Postgres with trust auth on localhost (the Homebrew default).

```sh
pnpm install
pnpm --filter @expendi-business/api db:setup-local   # once: roles + dev/test databases
cp apps/api/.env.example apps/api/.env               # configure local API/providers
pnpm --filter @expendi-business/api db:migrate
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @expendi-business/api dev              # API on :3000
```

Copy each frontend's `.env.example` to its local environment file and configure its API/Privy settings before starting it. Run each app in a separate terminal:

```sh
pnpm --filter @expendi-business/web dev              # customer dashboard on :3002
pnpm --filter @expendi-business/admin dev            # internal Ops on :3001
pnpm --filter @expendi-business/mobile dev           # Expo development client
```

The mobile app needs a native development build for its native integrations. Deployed API secrets live in Doppler; see the [foundation handoff](docs/handoffs/phase-0-foundation.md#environment-variables) and each later phase's environment-variable section.

## Docs

- [MVP spec](docs/expense-mvp-spec.md): agreed Kenya spending scope, flows, data model, go-live checklist and the roadmap after the MVP.
- [Build plan](docs/expense-mvp-build-plan.md): 51 ordered tasks and acceptance checkpoints.
- [Build handoffs](docs/handoffs/README.md): implementation notes and QA by phase.
- [Next-session handoff](docs/handoffs/next-session.md): outstanding setup, QA and known issues; consult newer runbooks for deployment updates.
- [Implementation guide](docs/implementation-guide.md): broader expense management, crypto invoicing and global payroll blueprint.
- [Customer imports](docs/runbooks/customer-imports.md): current import behavior, limitations and latest deployment evidence.
- [Pilot release](docs/runbooks/pilot-release.md): production builds, distribution and cutover.
- [How it works (for clients)](docs/client/how-expendi-business-works.png): original staff-claims diagram; due for an update to cover the wider product.

Task tracking lives in the Linear project **Expendi Business**. Handoffs record some issue-status updates as still owed; this README reflects repository evidence.
