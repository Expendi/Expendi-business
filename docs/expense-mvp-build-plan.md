# Implementation Plan: Expendi Business MVP

**Spec:** [expense-mvp-spec.md](expense-mvp-spec.md). Section numbers like "§7" refer to the spec.
**Status:** draft for review, 2026-11-01. Updated the same day when the scope widened to all company spending (spec §1):

- **New:** Task 33 (Phase 1), Phase 2B (Tasks 34–43), Task 44 (Phase 3)
- **Changed:** Tasks 7, 8, 21, 22, 24, 25, 26 and 29

## Overview

Build the MVP as one monorepo: `apps/api`, `apps/mobile`, `apps/web` (the company web dashboard, added 2026-11-02), `apps/admin` and `packages/shared`. The MVP is staff claims plus all company spending: petty cash, bills, subscriptions, salaries and company spending, all paid through Expendi.

The order is set by risk:

1. Company isolation and the payout engine come first, so the riskiest parts are proven with real money, for every payment method, before any screens are built.
2. Phase 2 builds the claim flow.
3. Phase 2B builds the rest of the spending on top of it.

Each task leaves the system working and testable.

## Architecture decisions (from the spec)

- **Stack:** the same as the consumer `backend/`: TypeScript, Hono, Effect, Drizzle, Postgres, Station-style Postgres jobs, Vitest, and Railway. Port its patterns; don't share code with it.
- **Company isolation:** every company-owned table has `organization_id`, plus Postgres row-level security. A reusable isolation test runs against every route.
- **Money:** each company gets a Privy server wallet with policies. Payouts go through Paycrest's Sender API, with ported `order-safety` checks. Amounts are stored as integers only.
- **Audit log:** one append-only log for users, staff and the system. The database rejects updates and deletes.
- **Services:** R2 for receipts, Resend for email, Expo push for notifications, the Zoho Books API for accounting sync. Invites go out by email (Resend); payout phone numbers are confirmed with Telnyx Verify SMS codes.

**Package names:** `@expendi-business/api`, `@expendi-business/mobile`, `@expendi-business/admin`, `@expendi-business/shared`.

**Verification commands (from the repo root):** `pnpm build`, `pnpm typecheck`, `pnpm test`. To run a single workspace: `pnpm --filter @expendi-business/api test`.

---

## Phase 0: Foundation

### Task 1: Scaffold the monorepo

**Description:** Set up the Turbo + pnpm workspace with `apps/api` (Hono + Effect, `/health`) and `packages/shared` (zod schemas). Copy the tooling (tsconfig, eslint, prettier, vitest) from the consumer repos.

**Acceptance criteria:**

- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm test` passes from the root
- [ ] `GET /health` returns 200
- [ ] Config loads through Effect `Config`, as in `backend/src/config.ts`

**Dependencies:** None
**Files likely touched:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `apps/api/src/{index,server,config}.ts`, `packages/shared/src/index.ts`
**Scope:** M

### Task 2: Database and company isolation

**Description:** Add Drizzle and Postgres with the `organizations`, `users` and `memberships` tables. Add middleware that resolves the caller's company from their membership. Add RLS policies keyed on a per-request `app.org_id` setting, and run the app as a non-owner database role. Add a reusable isolation test helper.

**Acceptance criteria:**

- [ ] Migrations run cleanly on an empty database
- [ ] A request for a company the caller doesn't belong to returns 403
- [ ] The isolation helper proves that a user in company A reads nothing from company B, even if a query leaves out its filter

**Dependencies:** Task 1
**Files likely touched:** `apps/api/src/db/schema/{organizations,users,memberships}.ts`, `apps/api/src/db/rls.sql`, `apps/api/src/middleware/tenant.ts`, `apps/api/src/__tests__/helpers/isolation.ts`
**Scope:** M

### Task 3: Audit log

**Description:** Create the `audit_log` table (§6.13, §10). The app role may only insert. A trigger blocks UPDATE and DELETE. Add an `AuditLog` Effect service and request-ID middleware.

**Acceptance criteria:**

- [ ] The service writes the actor type and ID, company, action, entity, before/after values, request ID, IP and user agent
- [ ] UPDATE and DELETE on `audit_log` fail in a database test
- [ ] User, staff and system actors are all supported

**Dependencies:** Task 2
**Files likely touched:** `apps/api/src/db/schema/audit-log.ts`, `apps/api/src/services/audit/audit-service.ts`, `apps/api/src/middleware/request-id.ts`, tests
**Scope:** S

### Task 4: Customer login

**Description:** Verify Privy access tokens from email + passkey login, create each user once (keyed by email, so invites can be claimed), and expose `GET /me` with the user's memberships and roles.

**Acceptance criteria:**

- [ ] A valid Privy token creates the user exactly once
- [ ] An invalid or expired token returns 401
- [ ] `GET /me` lists the user's companies and roles

**Dependencies:** Task 2
**Files likely touched:** `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/me.ts`, `apps/api/src/services/auth/`, tests
**Scope:** S

### Checkpoint A: Foundation

- [ ] Build, typecheck and tests pass
- [ ] The isolation helper passes
- [ ] The audit log is proven append-only

---

## Phase 1: Money path (riskiest, so first)

### Task 5: Spike on Privy wallet policies

**Description:** Answer the build check in §7. Can a Privy policy restrict a wallet to calling `transfer` on the USDC contract only, with a cap on the amount? Can its allowlist be updated through the API? Write down the answer and prove it in the Privy sandbox. The result decides between Paycrest's Sender API and calling Paycrest's onchain gateway contract directly.

**Acceptance criteria:**

- [ ] `docs/decisions/privy-wallet-policies.md` answers both questions, with links to the docs
- [ ] A sandbox test shows an over-limit or non-USDC transfer being blocked
- [ ] A recommendation is recorded: keep the Sender API, or switch to the gateway contract

**Dependencies:** None (can run in parallel with Phase 0)
**Files likely touched:** `docs/decisions/privy-wallet-policies.md`, `apps/api/scripts/spike-privy-policy.ts`
**Scope:** S

### Task 6: Company wallet and deposits

**Description:** When a company is created, create its Privy server wallet with the policy from Task 5. Add the `wallets` and `wallet_transactions` tables. Detect USDC deposits on Base, using the Alchemy webhook pattern from `backend/src/routes/alchemy-webhooks.ts`. Add a balance endpoint that includes the KES equivalent.

**Acceptance criteria:**

- [ ] Each company gets exactly one wallet, even if creation is retried
- [ ] USDC sent on Base shows up as a deposit within a minute
- [ ] Other tokens and other chains are never credited

**Dependencies:** Tasks 2, 3, 5
**Files likely touched:** `apps/api/src/db/schema/{wallets,wallet-transactions}.ts`, `apps/api/src/services/wallet/`, `apps/api/src/routes/{wallets,alchemy-webhooks}.ts`, tests
**Scope:** M

### Task 7: Paycrest client and order checks

**Description:** Port `paycrest-client.ts` and `order-safety.ts` from `backend/src/services/paycrest/`.

- **Exact-KES quoting (§6.7):** round the claim up to a whole shilling, round the USDC up to 6 decimals, and quote again if the amount crosses into a different rate band.
- **Recipients:** support every KES method a payee can have (§6.19):
  - M-Pesa number
  - Till (Buy Goods)
  - Paybill with an account number
  - Kenyan bank account

  The consumer `order-safety.ts` already checks the channel and, for Paybill, the business number. Load Paycrest's KES institutions list for bank codes. Every recipient carries an account name.

- **Record for spec §14:** Paycrest's maximum per order, settlement times for each channel, and whether it checks account names.

**Acceptance criteria:**

- [ ] Unit tests: KES 1,499.50 pays out KES 1,500, and the USDC sent never underpays
- [ ] Orders build correctly for each channel (M-Pesa number, Till, Paybill, bank), and `order-safety` rejects a channel or business-number mismatch
- [ ] Orders are rejected for: wrong network or token, deposit address equal to the refund address, expired, unexpected memo
- [ ] Paycrest has no sandbox, so unit tests mock the API. Live checks use small real amounts (Checkpoint B).

**Dependencies:** Task 1
**Files likely touched:** `apps/api/src/services/paycrest/{paycrest-client,order-safety,quote}.ts`, tests
**Scope:** M

### Task 8: Create and fund a payout

**Description:** Add the `payouts` table and **one payout engine for every kind of payment** (§6.7, §7). It doesn't need claims or bills to exist yet.

- **Inputs:** a company; a subject (`claim`, `bill` or `float`, optionally part of a payroll run); a recipient; a KES amount.
- **Recipient snapshot:** the recipient is copied onto the payout, so editing a payee later doesn't change a payment already made.
- **Checks before paying:**
  - the balance
  - the right cap: the daily cap for claims, floats and bills, or the payroll cap for a run (§7)
  - the pause flags for the company and the platform
- **Paying:** create the Paycrest order, validate it, and send exactly the USDC amount Paycrest asks for through Privy.
- **Batches:** one approval can cover several payouts, for **Pay all** on bills and for a payroll run.
  - The approval token is bound to the exact set of payouts and their total.
  - Each payout is still created, funded and failed on its own.
- **Approval token:** port the check from `backend/src/services/transaction-approval/`, with the admin's passkey as the confirmation. Settle the open item in spec §14: use Privy's passkey, or a dedicated WebAuthn credential.

**Acceptance criteria:**

- [ ] The same idempotency key twice produces one order and one transfer
- [ ] A short balance, the daily cap, a payroll run over its cap, or a pause rejects the payment with a reason, and no order is created
- [ ] One approval for a batch of 3 pays each exactly once, and changing any amount in the batch invalidates the approval
- [ ] Every step writes an audit entry

**Dependencies:** Tasks 3, 6, 7
**Files likely touched:** `apps/api/src/db/schema/payouts.ts`, `apps/api/src/services/payout/payout-service.ts`, `apps/api/src/services/approval/`, tests
**Scope:** M

### Task 9: Paycrest webhook and reconciliation

**Description:** Add a signed webhook endpoint that verifies the signature and then re-fetches the order. Add a reconciliation job that runs every minute: it only reads Paycrest and updates our statuses. An unclear outcome marks the payout `needs_review`, and money is never re-sent automatically (§6.8). Copy the safeguards documented in `backend/docs/qadi-ramps.md`.

**Acceptance criteria:**

- [ ] A duplicate webhook doesn't update the payout twice
- [ ] A bad signature is rejected and logged
- [ ] A timeout after funding sets `needs_review` and never triggers a second transfer

**Dependencies:** Task 8
**Files likely touched:** `apps/api/src/routes/paycrest-webhook.ts`, `apps/api/src/station/reconcile-paycrest.ts`, tests
**Scope:** M

### Task 10: Failed payouts and retry

**Description:** When Paycrest refunds an order, the USDC comes back to the wallet and the payout is marked failed. A retry creates a new payout with a new key.

**Acceptance criteria:**

- [ ] A refunded order marks the payout failed and the wallet balance is restored
- [ ] A retry pays exactly once

**Dependencies:** Task 9
**Files likely touched:** `apps/api/src/services/payout/`, tests
**Scope:** S

### Task 33: USDC payouts to allowlisted addresses

**Description:** Some payees are paid in USDC (§6.19), and withdrawals go to USDC addresses too (§6.9).

- Add the company's address allowlist, `withdrawal_addresses`, which both use. Adding or removing an address needs the admin's passkey and is audited.
- Add a direct-transfer provider to the payout engine (`provider = onchain`).
- A transfer goes only to an address on that company's allowlist. The backend enforces this, and so does the Privy policy where Task 5 shows that's possible.

**Acceptance criteria:**

- [ ] A USDC payout to an allowlisted address pays once and records the transaction hash
- [ ] A payout or withdrawal to an address that isn't on the allowlist is impossible
- [ ] Adding or removing an address needs a passkey and is audited

**Dependencies:** Tasks 5, 8
**Files likely touched:** `apps/api/src/db/schema/withdrawal-addresses.ts`, `apps/api/src/services/payout/onchain.ts`, `apps/api/src/routes/allowlist.ts`, tests
**Scope:** M

### Checkpoint B: Money path

- [ ] **5 real KES payouts** to M-Pesa numbers through the engine, using a script and a test company, including one forced failure that refunds (§13 item 1)
- [ ] One real payment each to an M-Pesa Till, a Paybill with an account number, a Kenyan bank account and an allowlisted USDC address (§13 item 11)
- [ ] A batch of 3 payouts under one approval, with one forced failure that doesn't affect the other two
- [ ] Wallet safety is proven with the policy, the `order-safety` checks, the daily cap and the payroll cap (§13 item 3)
- [ ] Review with a human before building any screens

---

## Phase 2: Claim flow

### Task 11: Mobile app scaffold and login

**Description:** Create `apps/mobile` with the same Expo SDK and libraries as the consumer app: expo-router, NativeWind, `@privy-io/expo` email login with passkeys, and React Query. Passkeys need the app's associated domain (iOS) and asset links (Android). Add an API client typed from `packages/shared`, and EAS development and preview profiles.

**Acceptance criteria:**

- [ ] The development build signs in with an email code, sets up a passkey, signs in again with it, and shows `/me`
- [ ] The preview APK installs on an Android phone
- [ ] An EAS Update channel is set up

**Dependencies:** Task 4
**Files likely touched:** `apps/mobile/{app.config.ts,eas.json,package.json}`, `apps/mobile/src/app/(auth)/`, `apps/mobile/src/lib/api.ts`
**Scope:** M

### Task 12: Company sign-up

**Description:** Add a Create company flow (§6.1): name, plus a KRA PIN validated against `^[AP]\d{9}[A-Z]$`. The creator becomes the admin. The company gets the starter categories and a wallet. The deposit screen shows the "USDC on Base only" warning and the balance in USDC and KES.

**Acceptance criteria:**

- [ ] An invalid KRA PIN is rejected
- [ ] A new company shows its deposit address and balance
- [ ] Two companies created by the same user stay isolated (isolation helper)

**Dependencies:** Tasks 6, 11
**Files likely touched:** `apps/api/src/routes/organizations.ts`, `apps/api/src/db/schema/categories.ts`, `apps/mobile/src/app/(onboarding)/`, tests
**Scope:** M

### Task 13: Staff invites

**Description:** The admin invites people by email, name and role (§6.2), and an email with the install link goes out (Resend). The invite creates the user row by email; the membership activates when that email signs in. Admins can remove members. Accountants have an email address and no login.

**Acceptance criteria:**

- [ ] An invited email signs in and gets an active membership with the right role
- [ ] A removed member loses access immediately
- [ ] Invites, role changes and removals are audited

**Dependencies:** Task 12
**Files likely touched:** `apps/api/src/routes/members.ts`, `apps/api/src/services/email/`, `apps/mobile/src/app/(admin)/team/`, tests
**Scope:** M

### Task 32: Payout phone verification

**Description:** Employees add their M-Pesa number and confirm it with an SMS code (§6.18). Port the consumer backend's phone verification with its Telnyx Verify provider (`backend/src/services/phone-verification/`: `otp-provider.ts`, `telnyx-verify-service.ts`, `phone-verification-service.ts`, `phone-normalization.ts`, and the `phone_verification_challenges` table). Only a confirmed number is written to `users.phone`. A number confirmed by a second person moves to them, and the previous holder is asked for a new one.

**Acceptance criteria:**

- [ ] A Kenyan number is normalised to E.164 and confirmed with a Telnyx code; non-Kenyan numbers are rejected
- [ ] Wrong codes, expired codes, too many attempts and resends inside the cooldown are refused
- [ ] Setting or changing the number is audited and emails the employee
- [ ] Approve & pay is refused while the employee has no confirmed number

**Dependencies:** Task 13
**Files likely touched:** `apps/api/src/services/phone-verification/`, `apps/api/src/routes/me.ts`, `apps/api/src/db/schema/phone-verification-challenges.ts`, `apps/mobile/src/app/(onboarding)/payout-number.tsx`, tests
**Scope:** M

### Task 14: Submit a claim with a photo

**Description:** Add the `expenses` and `receipt_files` tables. Uploads go to a private R2 bucket through signed URLs, under `org/<id>/`, and images are shrunk on the phone first. Employees get a list and an edit screen for their own claims. This covers the `submitted` and `rejected` statuses.

**Acceptance criteria:**

- [ ] An employee submits a photo claim and the file is stored under the company's folder
- [ ] Employees see only their own claims; admins see all of their company's claims
- [ ] Amounts are stored as integer cents

**Dependencies:** Task 13
**Files likely touched:** `apps/api/src/db/schema/{expenses,receipt-files}.ts`, `apps/api/src/services/storage/r2.ts`, `apps/api/src/routes/expenses.ts`, `apps/mobile/src/app/(employee)/claims/`
**Scope:** M

### Task 15: M-Pesa SMS parser

**Description:** Write a pure parser in `packages/shared` for the Buy Goods, Send Money and Paybill confirmation messages (§6.4), and connect it to a "paste SMS" option in the claim flow.

**Acceptance criteria:**

- [ ] Sample messages for each format parse the code, amount, counterparty, date and time
- [ ] An unknown format falls back to manual entry without crashing

**Dependencies:** Task 1 (parser), Task 14 (wiring)
**Files likely touched:** `packages/shared/src/mpesa-sms.ts`, `packages/shared/src/__tests__/mpesa-sms.test.ts`, `apps/mobile/src/app/(employee)/claims/new.tsx`
**Scope:** S

### Task 16: Read receipts with Claude

**Description:** Add an extraction endpoint: an image goes to a Claude vision model, and the structured fields come back validated against a zod schema. The fields pre-fill the review screen. An eval script scores accuracy on a folder of real receipts.

**Acceptance criteria:**

- [ ] The endpoint returns valid fields or a clear "couldn't read"
- [ ] The eval script reports accuracy for each field on about 50 receipts
- [ ] The employee always confirms the fields before submitting

**Dependencies:** Task 14
**Files likely touched:** `apps/api/src/services/extraction/`, `apps/api/src/routes/extract.ts`, `apps/api/scripts/eval-receipts.ts`, `apps/mobile/src/app/(employee)/claims/review.tsx`
**Scope:** M

### Task 17: eTIMS capture

**Description:** Scan the eTIMS QR code with the expo-camera barcode scanner and store the raw payload, invoice number and supplier PIN. Show employees a card with the company's KRA PIN. Set `etims_status`, including `not_required` for exempt categories (§6.6).

**Acceptance criteria:**

- [ ] Scanning an eTIMS QR fills in the invoice number
- [ ] An exempt category gives `not_required`
- [ ] Employees can see the company's KRA PIN

**Dependencies:** Task 14
**Files likely touched:** `apps/mobile/src/components/etims-scanner.tsx`, `apps/api/src/services/expenses/etims.ts`, tests
**Scope:** S

### Task 18: Claim rules

**Description:** Add per-company unique indexes on the M-Pesa code, the eTIMS invoice number and the file hash. Add the near-duplicate warning and the 60-day warning. A receipt or SMS is required (§6.5).

**Acceptance criteria:**

- [ ] An exact duplicate is blocked with a message that points to the earlier claim
- [ ] Near-duplicate and age warnings show to the admin
- [ ] Imported claims are included in duplicate checks

**Dependencies:** Tasks 14, 15
**Files likely touched:** `apps/api/src/db/schema/expenses.ts`, `apps/api/src/services/expenses/rules.ts`, tests
**Scope:** S

### Task 19: Approve & pay, and reject

**Description:** Build the admin queue and claim detail. The cost preview shows the KES received, the USDC, the fee and the total. Confirmation uses the admin's passkey (fingerprint/face), which produces an approval token bound to this payout and calls the payout engine. Paying is blocked until the employee has a confirmed payout number (Task 32). Rejecting requires a reason, and the employee can edit and resubmit. Self-approvals are flagged (§6.7, §4).

**Acceptance criteria:**

- [ ] Approving shows the exact cost, then pays exactly once
- [ ] Rejecting requires a reason, and the employee can resubmit
- [ ] Self-approvals are flagged in the audit log

**Dependencies:** Tasks 8, 10, 18, 32
**Files likely touched:** `apps/api/src/routes/approvals.ts`, `apps/mobile/src/app/(admin)/claims/`, tests
**Scope:** M

### Task 20: Push notifications

**Description:** Register Expo push tokens and send the four notifications in §6.10.

**Acceptance criteria:**

- [ ] All four events arrive on a real device
- [ ] Removed members get nothing

**Dependencies:** Task 19
**Files likely touched:** `apps/api/src/services/notification/`, `apps/mobile/src/lib/push.ts`
**Scope:** S

### Task 21: Wallet screen and withdrawals

**Description:** Show the wallet history. Admins manage the address allowlist from Task 33 and withdraw to an allowlisted address with their passkey. All of it is audited (§6.9).

**Acceptance criteria:**

- [ ] A withdrawal to an address that isn't on the allowlist is impossible
- [ ] Allowlist changes need confirmation and are audited
- [ ] History shows deposits, payouts, refunds and withdrawals

**Dependencies:** Tasks 6, 8, 33
**Files likely touched:** `apps/api/src/routes/wallets.ts`, `apps/mobile/src/app/(admin)/wallet/`
**Scope:** M

### Checkpoint C: Claim flow

- [ ] End to end on staging: an employee submits, an admin approves and pays, and the money arrives on M-Pesa
- [ ] The isolation helper covers every new route
- [ ] Review with a human

---

## Phase 2B: Spending and payments

This phase builds everything beyond staff claims (spec §5 "Kinds of money out", §6.19–6.24). It reuses the claim capture flow, the payout engine and push notifications from Phases 1–2.

### Task 34: Payees

**Description:** Add `payees` (§6.19, §10), with the API and admin screens to add, edit and archive them.

- **Methods:**
  - M-Pesa number
  - Till
  - Paybill with an account number
  - Kenyan bank account, with the bank picked from Paycrest's list
  - USDC, which goes on the Task 33 allowlist
  - paid outside Expendi
- **Employee payees** are linked to their membership. They're paid to their confirmed number (Task 32) unless an admin adds a bank account.
- **Changing payment details** needs the admin's passkey, is audited, emails every admin, and sets `details_changed_at`.

**Acceptance criteria:**

- [ ] Each method validates its details: a Kenyan phone in E.164, numeric Till and Paybill numbers, a bank from Paycrest's list, a Base address
- [ ] Changing payment details needs a passkey, is audited and emails every admin
- [ ] Paying a payee within 24 hours of a change needs a second confirmation, enforced in the API

**Dependencies:** Tasks 7, 13, 32, 33
**Files likely touched:** `apps/api/src/db/schema/payees.ts`, `apps/api/src/services/payees/`, `apps/api/src/routes/payees.ts`, `apps/mobile/src/app/(admin)/payees/`
**Scope:** M

### Task 35: Bills

**Description:** Add `bills` (§6.20) and one-off bills.

- **Fields:** payee, amount, due date, overview heading, category, reference, notes, and an optional invoice photo or PDF. The invoice reuses Task 14's upload and, when Tasks 16 and 17 are done, receipt reading and eTIMS capture.
- **Status job:** a daily job on Africa/Nairobi time moves bills from `upcoming` to `due` to `overdue`.
- **Admin actions:** mark a bill paid outside (with optional proof), or cancel it with a reason.

**Acceptance criteria:**

- [ ] Status moves upcoming → due → overdue on the right Nairobi dates, including around midnight
- [ ] Paid-outside and cancelled bills record who did it, when and why, and are audited
- [ ] Only admins can see bills

**Dependencies:** Tasks 14, 34
**Files likely touched:** `apps/api/src/db/schema/bills.ts`, `apps/api/src/routes/bills.ts`, `apps/api/src/station/bill-status.ts`, `apps/mobile/src/app/(admin)/bills/`
**Scope:** M

### Task 36: Recurring payments

**Description:** Add `recurring_items` (§6.20). Each one has:

- a payee
- a fixed or variable amount
- a schedule: weekly, monthly on a given day, quarterly or yearly
- a start date and an optional end date
- paid through Expendi or outside
- a reminder lead time

A daily job keeps exactly one unpaid future bill for each active item. It creates the next bill when the current one is paid, marked paid outside or cancelled. A variable bill can't be paid until its amount, and its reference if the payee needs one, is entered.

**Acceptance criteria:**

- [ ] Monthly on the 31st falls back to the last day of shorter months, and quarterly and yearly schedules land on the right dates
- [ ] Running the job twice never creates a second future bill (enforced by a unique constraint)
- [ ] Pausing or ending an item stops new bills, and existing bills stay

**Dependencies:** Task 35
**Files likely touched:** `apps/api/src/db/schema/recurring-items.ts`, `apps/api/src/services/recurring/`, `apps/api/src/station/recurring-bills.ts`, `apps/mobile/src/app/(admin)/recurring/`
**Scope:** M

### Task 37: Paying bills

**Description:** Admins tap **Pay** on one bill, or select several and tap **Pay all** (§6.20).

- **Preview:** each payee, the KES they receive, the USDC, the fees and the total.
- **Approval:** one passkey approval covers the batch (Task 8), and each bill gets its own payout.
- **Failures:** a failed bill moves to `payout_failed` with a retry, without touching the others.
- **Blocked:**
  - payees whose details changed in the last 24 hours need the second confirmation (Task 34)
  - paid-outside payees can't be paid through Expendi

**Acceptance criteria:**

- [ ] **Pay all** for 3 bills pays each once, and one failure leaves the other two paid
- [ ] A variable bill with no amount, or a paid-outside payee, can't be paid
- [ ] The daily cap applies to bill payments

**Dependencies:** Tasks 8, 10, 19, 36
**Files likely touched:** `apps/api/src/services/bills/pay.ts`, `apps/api/src/routes/bills.ts`, `apps/mobile/src/app/(admin)/bills/pay.tsx`
**Scope:** M

### Task 38: Salaries and payroll runs

**Description:** Salaries are recurring items under the Salaries & personnel heading (§6.21). Each one has:

- a payee: an employee or other personnel
- net pay
- a pay day
- a payment method

**Draft runs:** five days before pay day, a job creates a draft `payroll_runs` row with one bill per person and notifies admins (Task 43). For that run only, admins can change an amount, leave someone out or add a one-off payment, each with a reason.

**Privacy:** only admins see salaries and runs. Employees see only their own salary payments. This is enforced in the routes, and in RLS through `app_current_role()`, which Phase 0 provides.

**Acceptance criteria:**

- [ ] A draft run appears exactly once, 5 Nairobi days before pay day, with everyone active
- [ ] Adjustments, exclusions and one-offs need a reason and are audited
- [ ] An employee can't read anyone else's salary through any endpoint (tested with the isolation helper and a role check)

**Dependencies:** Tasks 34, 36
**Files likely touched:** `apps/api/src/db/schema/payroll-runs.ts`, `apps/api/src/services/payroll/`, `apps/api/src/station/payroll-drafts.ts`, `apps/mobile/src/app/(admin)/payroll/`
**Scope:** M

### Task 39: Paying payroll runs

**Description:** **Approve & pay all** on a draft run (§6.21).

- **Cap check:** the run total can't exceed the payroll cap: active salaries plus the company's margin, 20% by default (§7).
- **Paying:** one passkey approval covers the run, and each person is their own payout.
- **Progress:** the run shows how many payments are paid, paying and failed. A failed person can be retried alone.
- **Changing a salary or the margin** needs a second confirmation, is audited and emails every admin.

**Acceptance criteria:**

- [ ] A run of 3 pays each person once, and one failure is retried without paying the others again
- [ ] A run over its cap is refused
- [ ] Changing a salary or the margin needs a second confirmation and emails every admin

**Dependencies:** Tasks 8, 10, 38
**Files likely touched:** `apps/api/src/services/payroll/pay.ts`, `apps/api/src/routes/payroll.ts`, `apps/mobile/src/app/(admin)/payroll/[id].tsx`
**Scope:** M

### Task 40: Petty cash floats

**Description:** Add `floats` and `float_movements` (§6.22).

- **Issuing:** admins issue a float or top it up. Each is a payout to the employee's confirmed M-Pesa through the engine.
- **Spending:** employees record spending as **Paid from petty cash** with the claim capture flow. It's an expense of kind `float` with status `recorded`, and needs no approval or payout.
- **Balance:** issued + top-ups − spending − returns.
- **Overspend:** spending past the balance creates a claim for the extra.
- **Closing:** admins record returns and close floats.

**Acceptance criteria:**

- [ ] Issuing and topping up each pay the employee once and show in their balance
- [ ] Recording spending lowers the balance, and overspending creates a submitted claim for exactly the extra
- [ ] Admins see, for every float, what was issued, spent and left, and any spending without a receipt

**Dependencies:** Tasks 8, 14, 19, 32
**Files likely touched:** `apps/api/src/db/schema/floats.ts`, `apps/api/src/services/floats/`, `apps/api/src/routes/floats.ts`, `apps/mobile/src/app/(employee)/petty-cash/`, `apps/mobile/src/app/(admin)/petty-cash/`
**Scope:** M

### Task 41: Company spending

**Description:** Admins record money already spent outside Expendi (§6.23) with the claim capture flow.

- It's kind `company`, status `recorded`, under the Transactions heading by default.
- It records the account it was paid from, picked from a per-company list.
- An admin can save it without a receipt by giving a reason, and it's flagged.
- Marking a bill paid outside (Task 35) creates its company spending record.

**Acceptance criteria:**

- [ ] Company spending appears with its heading and its paid-from account
- [ ] Saving without a receipt needs a reason and is flagged
- [ ] Marking a bill paid outside creates exactly one company spending record

**Dependencies:** Tasks 14, 35
**Files likely touched:** `apps/api/src/services/expenses/company.ts`, `apps/api/src/routes/expenses.ts`, `apps/mobile/src/app/(admin)/spending/new.tsx`
**Scope:** S

### Task 42: Spending overview

**Description:** The admin's home screen (§6.24). All dates use Africa/Nairobi time. It shows:

- money out this month by heading and by category, compared with last month
- recent payments
- what's outstanding: overdue and due-today bills, claims waiting for approval, and petty cash spending without a receipt
- bills and payroll runs due in the next 30 days, each with **Pay**
- the cash check: the wallet balance against the next 30 days' total, as "Covered" or "Short by KES X"
- a view for each person

Employees get their own home screen with their claims, float balance and salary payments.

**Acceptance criteria:**

- [ ] Totals match a hand calculation on a seeded company that has every kind of spending
- [ ] The cash check changes from Covered to Short when a bill pushes the 30-day total past the balance
- [ ] Employees see nothing beyond their own claims, float and salary payments

**Dependencies:** Tasks 19, 37, 39, 40, 41
**Files likely touched:** `apps/api/src/services/overview/`, `apps/api/src/routes/overview.ts`, `apps/mobile/src/app/(admin)/index.tsx`, `apps/mobile/src/app/(employee)/index.tsx`
**Scope:** M

### Task 43: Reminders and spending notifications

**Description:** Add the new notifications in §6.10, by push and email:

- a bill due soon, due today, and overdue (once each)
- a payroll run ready to review
- the wallet short for the next 7 days
- a salary paid
- a float issued or topped up
- a payee's details changed (by email, to every admin)

A daily job on Nairobi time sends the reminders. Each one is sent once per bill and stage.

**Acceptance criteria:**

- [ ] Each reminder fires once, on the right Nairobi day, and never twice
- [ ] Every notification in §6.10 arrives on a real device or in an inbox
- [ ] Removed members get nothing

**Dependencies:** Tasks 20, 34, 36, 38, 40
**Files likely touched:** `apps/api/src/services/notification/`, `apps/api/src/station/reminders.ts`, `apps/api/src/services/email/`
**Scope:** M

### Checkpoint C2: Spending and payments

- [ ] On staging, all of these work end to end:
  - a recurring bill is created, reminded and paid
  - a payroll run of 3 is paid
  - a float is issued, spent from and overspent
  - company spending is recorded
  - the overview's numbers match a hand check
- [ ] Salaries are invisible to employees on every endpoint
- [ ] The isolation helper covers every new route
- [ ] Review with a human

---

## Phase 3: Accountant and internal tools

### Task 22: Monthly export

**Description:** Generate the Excel/CSV export described in §6.11.

- **Main sheet:** all money out in the month: claims, petty cash, bills, salaries per person, and company spending.
- **Second sheet:** bills that are due or overdue at month end.
- **Receipts:** a zip in R2, with files named to match the "receipt file" column.
- **Delivery:** admins can generate and share an export in the app. A job on the 1st of each month emails accountants a 30-day link through Resend, sent from `expendi.app` with SPF and DKIM set up.

**Acceptance criteria:**

- [ ] The export columns match §6.11
- [ ] The zip's filenames match the "receipt file" column
- [ ] A test run of the scheduled job sends the email

**Dependencies:** Tasks 19, 37, 39, 40, 41
**Files likely touched:** `apps/api/src/services/export/`, `apps/api/src/station/monthly-export.ts`, `apps/api/src/services/email/resend.ts`, `apps/mobile/src/app/(admin)/export.tsx`
**Scope:** M

### Task 23: Internal admin app and staff login

**Description:** Create `apps/admin` in Next.js, with email login through Privy restricted to the `staff_users` table. There are two roles, `ops_admin` and `ops_viewer`, enforced on the server. Staff sign-ins are audited.

**Acceptance criteria:**

- [ ] An email that isn't on the staff list can't sign in
- [ ] A viewer can't trigger any action (checked on the server)
- [ ] Sign-ins are audited

**Dependencies:** Task 3
**Files likely touched:** `apps/admin/`, `apps/api/src/db/schema/staff-users.ts`, `apps/api/src/routes/internal/auth.ts`
**Scope:** M

### Task 24: Companies, payout queue and pause

**Description:** Build company views and a queue of payouts (claims, bills, payroll runs and floats) that need review or have failed. Staff can re-fetch a payout from Paycrest, or resolve it with a note after a second confirmation. Staff can pause payouts for all companies or for one (§6.15, §7).

**Acceptance criteria:**

- [ ] There are no staff endpoints that create payouts or withdrawals
- [ ] Resolving or pausing needs a reason and a confirmation, and is audited
- [ ] A pause blocks new payouts immediately

**Dependencies:** Tasks 9, 23
**Files likely touched:** `apps/api/src/routes/internal/{companies,payouts,controls}.ts`, `apps/admin/src/app/{companies,payouts,controls}/`
**Scope:** M

### Task 25: Spreadsheet import

**Description:** Staff upload a CSV for each part of the pilot's spreadsheet (petty cash, transactions, salaries, subscriptions), map its columns and see a dry-run report. The import then creates (§6.12):

- payees for staff and suppliers, with payment details left for an admin to confirm
- salaries and recurring bills with their next due dates
- unpaid bills
- `submitted` claims from unpaid staff claims
- open petty cash floats
- `paid_outside` history from paid rows in the last 3 months

Each run is recorded in `import_runs`, and keying on a hash of each row makes re-runs safe.

**Acceptance criteria:**

- [ ] A dry run writes nothing
- [ ] Re-running the same file imports nothing new
- [ ] Imported claims are included in duplicate checks

**Dependencies:** Tasks 18, 23, 34, 36, 38, 40
**Files likely touched:** `apps/api/src/services/import/`, `apps/api/src/routes/internal/imports.ts`, `apps/admin/src/app/imports/`
**Scope:** M

### Task 26: Alerts

**Description:** Add the six alerts in §6.16. They're emailed through Resend to the alert list, with only one email per open alert. The low-balance alert counts unpaid claims plus the bills and payroll due in the next 7 days. The admin app gets an alerts page and a system health page showing the last reconciliation run and webhook failures.

**Acceptance criteria:**

- [ ] Each alert fires in a test
- [ ] Only one email is sent per open alert
- [ ] "Reconciliation stopped" fires when the job has been paused for more than 5 minutes

**Dependencies:** Tasks 9, 23, 31, 37, 39
**Files likely touched:** `apps/api/src/services/alerts/`, `apps/api/src/station/alert-checks.ts`, `apps/admin/src/app/{alerts,health}/`
**Scope:** M

### Task 27: Audit log viewer

**Description:** Staff can search the audit log by company, actor, action and date.

**Acceptance criteria:**

- [ ] Staff can find any entry by company, actor, action or date
- [ ] The viewer is read-only

**Dependencies:** Task 23
**Files likely touched:** `apps/api/src/routes/internal/audit.ts`, `apps/admin/src/app/audit/`
**Scope:** S

### Task 30: Zoho Books connection and account mapping

**Description:** Staff send a one-time connect link from the internal admin app (§6.17). The link starts Zoho's OAuth sign-in. The callback stores the encrypted refresh token, the accounts server and the API domain. Staff then pick the Zoho organization (refused unless its currency is KES), map each category to a Zoho expense account, and choose the Paid Through and default accounts. Staff can disconnect.

**Acceptance criteria:**

- [ ] A used or expired connect link is refused
- [ ] Connecting a non-KES Zoho organization is refused
- [ ] The refresh token is encrypted at rest and no endpoint returns it
- [ ] Connecting, disconnecting and mapping changes are audited
- [ ] The cross-company isolation test covers the new routes and tables

**Dependencies:** Tasks 12, 23
**Files likely touched:** `apps/api/src/services/zoho/`, `apps/api/src/routes/integrations/zoho.ts`, `apps/api/src/routes/internal/accounting.ts`, `apps/api/src/db/schema/accounting.ts`, `apps/admin/src/app/companies/[id]/zoho/`
**Scope:** M

### Task 31: Push paid claims to Zoho Books

**Description:** When a claim reaches `paid`, queue a job in the same transaction. The job creates a Zoho expense with the fields in §6.17 and attaches the receipt. Before retrying a create, it searches Zoho by the claim's reference so a retry never duplicates. A rejected token marks the connection `needs_reconnect` and pauses syncing. The internal admin app lists failed syncs with a retry button. Failures are recorded so the "Zoho sync failing" alert in Task 26 can fire.

**Acceptance criteria:**

- [ ] A paid claim appears in a test Zoho organization with the right account, amount, reference and receipt
- [ ] `paid_outside` claims and claims that aren't `paid` never sync
- [ ] A create that times out and is retried leaves exactly one Zoho expense
- [ ] A revoked token marks the connection `needs_reconnect`, and claims paid in the meantime sync after reconnecting
- [ ] Staff can retry a failed sync from the internal admin app

**Dependencies:** Tasks 9, 19, 30
**Files likely touched:** `apps/api/src/services/zoho/`, `apps/api/src/station/zoho-sync.ts`, `apps/api/src/routes/internal/accounting.ts`, `apps/admin/src/app/companies/[id]/zoho/`
**Scope:** M

### Task 44: Push other paid spending to Zoho Books

**Description:** Extend the Task 31 sync to everything under **What syncs** in §6.17:

- petty cash spending, paid through the petty cash account the accountant picks
- bills, whether paid through Expendi or outside
- company spending, paid through its mapped account
- each payroll run, as one expense to a salaries account

Add these mapping fields to the Task 30 screens. Float issues and top-ups never sync.

**Acceptance criteria:**

- [ ] Each kind appears in a test Zoho organization with the right expense account, Paid Through account, amount and reference
- [ ] A payroll run posts one expense for the run's total, with no per-person amounts
- [ ] Float issues, top-ups and imported history never sync

**Dependencies:** Tasks 31, 37, 39, 40, 41
**Files likely touched:** `apps/api/src/services/zoho/`, `apps/api/src/station/zoho-sync.ts`, `apps/admin/src/app/companies/[id]/zoho/`
**Scope:** M

### Checkpoint D: Ready for internal tools

- [ ] Go-live checklist items 2–6 in §13 pass
- [ ] Every kind of paid spending syncs to a test Zoho Books organization (§6.17)
- [ ] Review with a human

---

## Phase 3B: Web dashboard

Added to the MVP on 2026-11-02 (spec §6.14). A Next.js app at `business.expendi.app` for company admins and accountants. It reuses the API the app uses; the API work here is mostly accountant access, a few read endpoints and browser CORS. It runs in parallel with Phases 2B and 3. Each screen task waits for the API task it sits on.

### Task 45: Web dashboard scaffold, sign-in and hosting

**Description:** Create `apps/web` in Next.js, following `apps/admin`'s structure and tooling.

- **Sign-in:** Privy email code, then a passkey in the browser, with the same accounts as the app. A person in several companies picks one. An employee is told to use the app.
- **API client:** typed from `packages/shared`.
- **Navigation:** depends on the role; accountants see no action buttons.
- **API side:** CORS on customer routes only for `DASHBOARD_ORIGINS`, and `WEBAUTHN_ORIGINS` gains `https://business.expendi.app`.
- **Hosting:** Vercel at `business.expendi.app`.
- **Passkey files:** serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` as `application/json`, with no redirect. Keep one source of truth for them (today `apps/mobile/well-known/`).

**Acceptance criteria:**

- [ ] An admin and an accountant sign in; an employee is told to use the app
- [ ] The passkey association files are served with the right content type and validate with Apple's and Google's checkers
- [ ] Browser requests from any other origin are refused by the API

**Dependencies:** Tasks 11, 23
**Files likely touched:** `apps/web/`, `apps/api/src/middleware/`, `apps/api/src/config.ts`
**Scope:** M

### Task 46: Accountant access

**Description:** Accountants become view-only dashboard users (spec §4, §6.14).

- **Invites:** an accountant invite creates or links a `users` row by email, like other invites. The membership activates on first sign-in. Existing email-only accountant memberships are linked by email.
- **Read access:** the `accountant` role can read every company read route, salaries and payroll included (Dennis, 2026-11-02).
- **No writes:** every action route refuses accountants, enforced in the API with a route-listing test like T23's internal-route test.
- **Several companies:** an accountant on several companies switches between them.

**Acceptance criteria:**

- [ ] An accountant sees everything in their company, read-only, including salaries
- [ ] Every action route refuses an accountant (tested by listing the routes)
- [ ] An accountant on two companies sees each separately; a removed accountant loses access immediately

**Dependencies:** Tasks 13, 45
**Files likely touched:** `apps/api/src/db/schema/memberships.ts`, `apps/api/src/middleware/tenant.ts`, `apps/api/src/services/membership/`, tests
**Scope:** M

### Task 47: Expenses and approvals on the web

**Description:**

- **All expenses:** claims, petty cash and company spending, filterable by employee, kind, category, month and eTIMS status (new read endpoint), with the receipts beside the details.
- **Approval queue:** the receipt beside each claim, warnings shown, and select several claims → one passkey confirmation (Task 19's batch API, up to 20).
- **Claim actions:** reject with a reason, retry a failed payout.
- **Passkey on a phone:** the browser offers "use a phone or tablet", so the admin can confirm with the phone.

**Acceptance criteria:**

- [ ] An admin approves and pays several claims with one passkey from a desktop browser, and each pays exactly once
- [ ] The expense filters work across claims, petty cash and company spending
- [ ] Accountants see the same lists, with no actions

**Dependencies:** Tasks 19, 45 (and 40 and 41 for those kinds)
**Files likely touched:** `apps/web/src/app/(company)/expenses/`, `apps/web/src/app/(company)/approvals/`, `apps/api/src/routes/expenses.ts`
**Scope:** M

### Task 48: Bills, recurring payments, payees and payroll on the web

**Description:** Everything the app can do for these, on the web:

- **Payees:** detail changes with a passkey.
- **Bills:** **Pay** and **Pay all** (Task 37).
- **Payroll runs:** drafts and adjustments (Task 38) and **Approve & pay all** (Task 39).
- **Invoices:** desktop upload of invoice PDFs, which the app can't pick yet.

**Acceptance criteria:**

- [ ] An admin pays several due bills with one passkey from the browser
- [ ] An admin adjusts and pays a payroll run from the browser
- [ ] Accountants see bills, payees and payroll runs read-only, salaries included

**Dependencies:** Tasks 34–39, 45
**Files likely touched:** `apps/web/src/app/(company)/{bills,recurring,payees,payroll}/`
**Scope:** M

### Task 49: Wallet, team, settings and activity on the web

**Description:**

- **Wallet:** balance in USDC and KES, deposit address ("send USDC on Base only"), history, and withdrawals and allowed addresses with a passkey.
- **Team:** invite, change roles, remove, including accountants.
- **Settings:**
  - company details
  - the category list: add, rename, archive and mark eTIMS-exempt. These are new audited API routes; categories were seeded but never editable.
  - the admin's approval passkey: set it up in the browser under the existing rules
- **Activity:** the company's own audit log, read-only, for admins and accountants. A company-scoped read; the staff search function stays staff-only.

**Acceptance criteria:**

- [ ] An admin withdraws to an allowlisted address with a passkey from the browser
- [ ] Category changes are audited, and an archived category can't be picked for new spending
- [ ] Admins and accountants see only their own company's activity

**Dependencies:** Tasks 12, 13, 21, 45, 46
**Files likely touched:** `apps/web/src/app/(company)/{wallet,team,settings,activity}/`, `apps/api/src/routes/categories.ts`, `apps/api/src/routes/activity.ts`
**Scope:** M

### Task 50: Spending overview on the web

**Description:** The spending overview (§6.24) on a big screen, from Task 42's API.

**Acceptance criteria:**

- [ ] The overview's figures match the app's for the same company and month

**Dependencies:** Tasks 42, 45
**Files likely touched:** `apps/web/src/app/(company)/overview/`
**Scope:** S

### Task 51: Accountant downloads and the eTIMS report

**Description:**

- **Downloads:** the monthly export and receipts zip (Task 22) for any month.
- **eTIMS report:** for a month, each expense with its date, merchant, amount, eTIMS status, invoice number and supplier PIN, as CSV with a byte-order mark, like the export.
- **Who:** both admins and accountants.

**Acceptance criteria:**

- [ ] An accountant downloads the export, the receipts zip and the eTIMS report for a chosen month
- [ ] The eTIMS report matches the month's expenses

**Dependencies:** Tasks 22, 46
**Files likely touched:** `apps/api/src/services/export/`, `apps/api/src/routes/reports.ts`, `apps/web/src/app/(company)/reports/`
**Scope:** S

### Checkpoint D2: Web dashboard

- [ ] Go-live checklist item 17 in §13 passes
- [ ] The isolation helper covers every new route, and the accountant route-listing test passes
- [ ] Review with a human

---

## Phase 4: Pilot launch

### Task 28: Getting the app to staff

**Description:** Make production EAS builds. Distribute through external TestFlight testing (which needs Apple's beta review) and a Play internal or closed testing track, and set up the EAS Update production channel. Submit the iOS build a week before go-live.

**Acceptance criteria:**

- [ ] Pilot staff can install from an invite link on every platform they use
- [ ] An over-the-air update reaches installed apps

**Dependencies:** Task 11
**Files likely touched:** `apps/mobile/eas.json`, `apps/mobile/app.config.ts`
**Scope:** S

### Task 29: Pilot go-live

**Description:** Work through §13 with the pilot company:

- create the company and deposit USDC
- invite staff
- run the import dry run and review it with the founder, including payees, salaries and recurring bills
- confirm every payee's payment details
- freeze the spreadsheet
- send the accountant a sample export
- pay the first real claim

**Acceptance criteria:**

- [ ] Every item in §13 is ticked
- [ ] The first real claim is paid. **Live.**

**Dependencies:** All tasks
**Scope:** S (operations)

---

## What can run in parallel

| Track          | Tasks                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| Money          | 5 → 6 → 7 → 8 → 9 → 10 → 33 (Task 5 can start on day one)                                  |
| Spending       | 34 (after 13, 32, 33) → 35 → 36 → 37 and 38 → 39; 40 after 19; 41 after 35; 42 and 43 last |
| Mobile         | 11 can start once Task 4 is done; 15 (the parser) any time; 32 follows 13                  |
| Internal tools | 23 → 27 can start once Task 3 is done; 24–26 wait on Task 9                                |
| Zoho Books     | 30 can start once Tasks 12 and 23 are done; 31 waits on Task 19                            |
| Web dashboard  | 45 → 46 any time; 47–51 each after the API task they sit on (19, 37–39, 21, 42, 22)        |

These must run in sequence: database migrations, and anything that depends on the payout engine (Tasks 8–10 before 19).

## Risks and mitigations

| Risk                                                                              | Impact | Mitigation                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privy policies can't cap ERC-20 transfer amounts                                  | High   | Task 5 runs first. Fallback: Paycrest's onchain gateway contract                                                                                                      |
| Paycrest has never run in production for Expendi                                  | High   | The money path is built before the UI, with 5 real payouts at Checkpoint B                                                                                            |
| Paycrest rejects M-Pesa names that don't match                                    | Medium | Collect full legal names, and test with real staff numbers early                                                                                                      |
| Claude misreads Kenyan receipts                                                   | Medium | Task 16 eval on about 50 real receipts; employees always confirm                                                                                                      |
| Friction between row-level security and Drizzle                                   | Medium | Proven in Task 2 with the isolation helper before any features                                                                                                        |
| TestFlight beta review is slow                                                    | Low    | Submit iOS a week early; Android doesn't need review                                                                                                                  |
| Resend emails land in spam                                                        | Medium | Invites now depend on email: set up SPF/DKIM in Task 13, not Task 22                                                                                                  |
| Pilot phones can't use passkeys                                                   | Medium | Check devices early (iOS 16+ / Android 9+ with a screen lock). Employees can still sign in with an email code; admins need a passkey-capable phone to approve payouts |
| Zoho's API has no idempotency key, so a retried create could duplicate an expense | Medium | Search Zoho by the claim's reference before any retry (Task 31)                                                                                                       |
| Paycrest's maximum per order is below some salaries                               | High   | Check in Task 7. If it is, split one person's pay into several orders under the same approval                                                                         |
| Payee payment details swapped by a fraudster                                      | High   | Passkey to change details, an email to every admin, and a second confirmation within 24 hours (Task 34)                                                               |
| Salaries leak to employees                                                        | High   | Admin-only salary endpoints, with a role test on every one (Task 38)                                                                                                  |
| Date logic off by a day around midnight or month ends                             | Medium | All schedules on Africa/Nairobi time, with tests for the 31st, February and midnight (Tasks 35, 36)                                                                   |

## Open questions

- **Telnyx account:** reuse the consumer backend's Telnyx account with a new Verify profile for Expendi Business, or open a separate one (Task 32).
- **Pricing after the free period:** a subscription, a fee on payment volume, or both (spec §14).
- **Zoho posting for salaries and petty cash:** confirm with the pilot's accountant before Task 44.
- **VAT on eTIMS expenses:** Task 31 posts gross amounts with the eTIMS details in the description. Confirm with the pilot's accountant before Task 31 that this works for them, or whether they need VAT split out.
