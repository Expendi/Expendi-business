# Expendi Business

B2B stablecoin finance for African startups. The current Kenya MVP brings staff claims, petty cash, supplier bills, subscriptions and salary payments into one workspace, with mobile, customer web and internal operations apps.

Companies hold USDC on NEAR in wallets managed by Expendi. The payment engine supports KES payouts to M-Pesa numbers, Tills, Paybills and Kenyan bank accounts, plus USDC transfers to NEAR, Base and Solana. Staff claims currently reimburse to verified M-Pesa numbers; payroll currently pays fixed net salaries in KES.

## NEAR HACKATHON submission

**Track 08 · Real-World Money.** Expendi Business already ran on Base before the hackathon. What was built for NEAR HACKATHON is the port that makes NEAR the main chain: everything on the `chain/near` branch after the `pre-hackathon-near` tag. [See the diff](https://github.com/Expendi/Expendi-business/compare/pre-hackathon-near...chain/near).

A Kenyan company keeps its money as USDC in its own NEAR account. From there it pays staff claims, supplier bills and payroll, to M-Pesa or to a USDC payee on the chain the payee chooses. It never sees a gas token.

| Track tag         | How it is used                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stablecoins       | Every company's balance is native USDC on NEAR. The ledger, approvals, payroll and accountant export all run on it.                                                                                                                                |
| NEAR Intents      | Companies fund in with USDC from Base, Ethereum, Arbitrum or Solana. USDC payees on Base or Solana are paid through 1Click. Each M-Pesa cash-out moves the exact amount to Base through 1Click, because the KES off-ramp (Paycrest) settles there. |
| Meta transactions | Each company wallet is a Privy server wallet that signs NEP-366 delegate actions. Expendi's gas relayer pays every fee, creates each account and pays its USDC registration.                                                                       |

### How the money moves

1. **Wallet.** A company gets a NEAR company wallet (a Privy wallet, owned by Expendi's management key, which the API signs for under its own key) and a Base transit wallet.
2. **Fund-in.** A plain USDC transfer on NEAR is credited once the chain confirms it. A fund-in from another chain is a 1Click quote that delivers USDC on NEAR. Transfers Expendi itself caused (refunds, sweeps, relayer transfers) are recognised by transaction hash and never credited.
3. **Approval.** An admin approves a claim, bill or payroll run with a passkey. The per-transaction cap is checked by the API immediately before Privy signs.
4. **Payout.** A NEAR payee is paid directly. A Base or Solana payee is paid through 1Click. A payroll run's M-Pesa cash-outs move to the transit wallet in one Base hop, then Paycrest pays each person in KES.
5. **Safety.** Every signed send is saved before it is broadcast, so a retry re-sends the same bytes and can never pay twice. Anything unclear goes to `needs_review`, and staff resolve it from the chain's evidence.

The design and its trade-offs are in [docs/decisions/near-main-chain.md](docs/decisions/near-main-chain.md). Terms are in [CONTEXT.md](CONTEXT.md).

### Check it yourself

Needs Node 22, pnpm 10 and a local Postgres with trust auth. No provider keys are needed: the tests use in-memory fakes of NEAR, 1Click, Privy, Paycrest and Alchemy, and the fake NEAR chain runs the real borsh-encoded transactions.

```sh
pnpm install
pnpm --filter @expendi-business/api db:setup-local
pnpm --filter @expendi-business/shared build
pnpm --filter @expendi-business/api test
```

You should see every test pass. The NEAR behaviour lives in these files under `apps/api/src/__tests__/`:

| Do                                            | See                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/company-wallet-send.test.ts`        | A send over the cap is refused before signing; a retried send relays the same saved bytes; a send is only called expired once the chain proves its nonce unused. |
| `services/near-deposits.serial.test.ts`       | Deposits are credited once, forged events from other contracts are ignored, and Expendi's own refunds are skipped.                                               |
| `services/base-hop.test.ts`                   | A payroll run hops to Base once, splits when it exceeds the cap, and resumes after a crash at any step.                                                          |
| `services/usdc-delivery.test.ts`              | USDC payees on Base and Solana are paid through 1Click; a refunded quote returns the money and fails the payout cleanly.                                         |
| `routes/fund-ins.test.ts`                     | Fund-in from Base, Ethereum, Arbitrum and Solana.                                                                                                                |
| `routes/internal-near-payouts.serial.test.ts` | Staff resolve a stuck NEAR payout from the chain's evidence, without signing anything.                                                                           |

### On mainnet

- [`9HtNEa3es1a6FGcbYRBytbsBU6kBuY26taGsvYZVbdeH`](https://nearblocks.io/txns/9HtNEa3es1a6FGcbYRBytbsBU6kBuY26taGsvYZVbdeH): the gas relayer, a Privy server wallet, registering itself with the NEAR USDC contract. The transaction was built by the API, signed by Privy and broadcast by the API.
- Company wallet [`cfe4f640…312d02`](https://nearblocks.io/address/cfe4f640d78bd13a6cbefd5301f94466d24fdca2790ef0d46f135cd1bd312d02), created by the same `ensureCompanyWallet` that company sign-up uses: a Privy NEAR wallet, put on chain and registered for USDC by the relayer, plus its Base transit wallet.
- [`Hdok6k8RBUGxTjkhjokAA884P64MxPmMsPsnnmgGpsS4`](https://nearblocks.io/txns/Hdok6k8RBUGxTjkhjokAA884P64MxPmMsPsnnmgGpsS4): the relayer sends the company wallet 0.5 USDC. The deposit watcher, run against FastNEAR and the RPC, classed it as internal and credited nothing, because the relayer's own transfers are never deposits.
- [`8YXj2VoApYJxqtXAPeBqiZMPP1XPRhQyeJQ1zcpe36kB`](https://nearblocks.io/txns/8YXj2VoApYJxqtXAPeBqiZMPP1XPRhQyeJQ1zcpe36kB): the company wallet sends 0.2 USDC as a Privy-signed NEP-366 delegate action that the relayer submitted and paid for. The company wallet's NEAR balance did not change. `apps/api/scripts/near-mainnet-smoke.ts` repeats steps like these for any company.
- `apps/api/scripts/spike-privy-near.ts` is the go/no-go spike run on 2026-11-10. It creates a Privy NEAR wallet, has a relayer pay gas for its delegate action, and prices 1Click routes. It needs the Privy app's keys.

### Disclosure

- Expendi Business existed on Base before NEAR HACKATHON. The NEAR port is the hackathon work.
- Code was written with Claude Code (Anthropic), using parallel subagents, and reviewed and verified in the main session.
- Libraries: `near-api-js`, `@privy-io/node`, `@defuse-protocol/one-click-sdk-typescript`, plus the existing stack listed under Development.

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

- One managed Privy wallet per company on NEAR, with a Base transit wallet for cash-outs; NEAR USDC deposit detection, fund-in from other chains through NEAR Intents, ledger/history and KES balance estimates.
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
- [ ] **Additional assets/rails:** USDT/DAI and the required additional fiat currencies/chains; the current engine operates on NEAR USDC, with Base for cash-outs, and Kenyan payout rails.
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

- [MVP spec](docs/expense-mvp-spec.md): agreed Kenya spending scope, flows, data model and go-live checklist.
- [Build plan](docs/expense-mvp-build-plan.md): 51 ordered tasks and acceptance checkpoints.
- [Build handoffs](docs/handoffs/README.md): implementation notes and QA by phase.
- [Next-session handoff](docs/handoffs/next-session.md): outstanding setup, QA and known issues; consult newer runbooks for deployment updates.
- [Implementation guide](docs/implementation-guide.md): broader expense management, crypto invoicing and global payroll blueprint.
- [Customer imports](docs/runbooks/customer-imports.md): current import behavior, limitations and latest deployment evidence.
- [Pilot release](docs/runbooks/pilot-release.md): production builds, distribution and cutover.
- [How it works (for clients)](docs/client/how-expendi-business-works.png): original staff-claims diagram; due for an update to cover the wider product.

Task tracking lives in the Linear project **Expendi Business**. Handoffs record some issue-status updates as still owed; this README reflects repository evidence.
