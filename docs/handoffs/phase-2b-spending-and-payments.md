# Phase 2B Handoff: Spending & payments

**Linear:** milestone "Phase 2B · Spending & payments"

- EXP-305 (T34) Payees
- EXP-306 (T35) Bills
- EXP-307 (T36) Recurring payments
- EXP-308 (T41) Company spending
- EXP-309 (T37) Paying bills
- EXP-310 (T38) Salaries and payroll runs
- EXP-312 (T39) Paying payroll runs
- EXP-311 (T40) Petty cash floats
- EXP-313 (T43) Reminders and spending notifications
- EXP-314 (T42) Spending overview

**Goal:** everything the pilot asked for beyond staff claims. The founder can see and pay petty cash, transactions, salaries and subscriptions, each with a due date. At the end, the app's home screen answers the pilot's four questions:

- Where is the money going?
- What has been paid?
- What is outstanding?
- What needs to be paid next?

## Start prompt

> Read `docs/handoffs/README.md`, the Handoff notes in `docs/handoffs/phase-2-claim-flow.md`, then `docs/handoffs/phase-2b-spending-and-payments.md`. Build Phase 2B one task at a time, in the order listed, reading each task's Linear issue first. Stop at Checkpoint C2 and go through the QA checklist with me on real phones.

## Read first

- **Spec:**
  - §1 (what we're building and why payments run through Expendi)
  - §5 "Kinds of money out"
  - §6.19–6.24 (payees, bills, salaries, floats, company spending, the overview)
  - §6.10 (the new notifications)
  - §7 (named purposes, the payroll cap, payee-change protection)
  - §10: `payees`, `recurring_items`, `bills`, `payroll_runs`, `floats`, `float_movements`, and the `expenses.kind` and `payouts.subject_type` columns
- **Build plan:** Tasks 34–43
- **Consumer backend** (`/Users/chizaa/Documents/projects/expendi/backend/`):
  - `src/services/recurring-payment/`: how schedules run on Station, for reference
  - `docs/bulk-payouts-spec.md`: a draft for batch M-Pesa payouts, useful for payroll runs

## What the pilot asked for

> Something lightweight that allows me to know, at any given moment: where the money is going, what has been paid, what is outstanding, what needs to be paid next. Petty cash, transactions, salaries & personnel, subscriptions. Then when they are due.

The overview groups spending under exactly those four headings.

## Where things stand

Phases 0–2 are done; check their Handoff notes. **Start only when the Phase 2B gate of Checkpoint B has passed:** one real payment each to a Till, a Paybill, a Kenyan bank and an allowlisted USDC address, and the payroll cap (see "Split" in the Phase 1 handoff).

- **Payouts:** the engine pays any subject with batches and caps (T8). Paycrest supports every KES channel (T7). USDC payouts to allowlisted addresses work (T33).
- **Claims:** the claim flow works end to end (T11–T21).
- **Building blocks:** push notifications (T20), email (T13) and confirmed payout numbers (T32) exist.
- **Expenses table:** it already has the `kind`, `overview_heading`, `float_id` and `paid_from_account` columns.

## Inputs needed from Dennis

1. A few of the pilot's real recurring items to test with: subscriptions, regular suppliers and the payroll list. Fake names are fine.
2. Which subscriptions can only be paid by card. These are set up as _paid outside_.
3. The statutory payments the pilot makes (PAYE, NSSF, SHIF, Housing Levy) and their Paybill details.

## Tasks, in order

T34 → T35 → T36 → T41 → T37 → T38 → T39 → T40 → T43 → T42

T40 only needs Phase 2, so it can run in parallel with the others.

**Notes**

- **T34 Payees:**
  - Changing payment details is the main route for fraud. It needs the admin's passkey, an audit entry and an email to every admin, and it sets `details_changed_at`.
  - The 24-hour second confirmation is enforced **in the API**, not just the UI.
  - Bank codes come from Paycrest's list (T7). USDC addresses go through the T33 allowlist.
- **T35 Bills:**
  - The daily status job runs on Africa/Nairobi time and is safe to run twice.
  - Bills are admin-only.
- **T36 Recurring payments:**
  - Test the edge cases: the 29th–31st, February, leap years.
  - A unique constraint keeps **one unpaid future bill per item**. The next bill is created when the current one is paid, marked paid outside or cancelled.
- **T41 Company spending:**
  - Marking a bill paid outside creates exactly one record, even if retried.
  - Each company has its own list of paid-from accounts.
- **T37 Paying bills:**
  - One approval covers the batch. Each bill gets its own payout, and failures stay isolated.
  - The daily cap applies.
  - Paid-outside payees can't be paid, and variable bills need an amount first.
- **T38 Salaries:**
  - Salaries are `recurring_items` under the `salaries` heading.
  - Personnel without an app login are payees of kind `personnel`.
  - **Privacy:** put a role check on every salary route and test it. Employees see only their own salary payments.
  - **Enforce it in the database too:** Phase 0 sets `app.role` per transaction. Write the RLS policies on salary rows (salary `recurring_items`, payroll `bills`, `payroll_runs`) so only `app_current_role() = 'admin'` can read other people's salaries. Every salary route must call `withScope` with the tenant, which carries the role.
- **T39 Paying payroll:**
  - The payroll cap is active salaries × (1 + margin).
  - If T7 found that Paycrest's per-order maximum is below a salary, split that person's pay into several orders under the same approval.
  - A failed person is retried alone.
- **T40 Floats:**
  - Issuing and topping up go through the engine (subject `float`).
  - Spending is an expense of kind `float` with status `recorded`.
  - Work out the balance from movements and spending; don't store a balance that can drift.
  - Overspending creates a claim for exactly the extra.
- **T43 Reminders:**
  - Each reminder is sent once per bill and stage.
  - Reuse T34's payee-change email.
- **T42 Overview:**
  - Build a seeded test company with every kind of spending, and check every total against a hand calculation.
  - All dates use Nairobi time.
- **Every task:**
  - isolation tests on new routes
  - audit entries for every change to money, access or settings
  - money as integers only

## Environment variables

None new. This phase reuses Paycrest, Privy, Resend, Expo push and R2.

## Exit criteria: Checkpoint C2

- On staging, all of these work end to end:
  - a recurring bill is created, reminded and paid
  - a payroll run of 3 is paid
  - a float is issued, spent from and overspent
  - company spending is recorded
  - the overview's numbers match a hand check
- Salaries are invisible to employees on every endpoint
- The isolation helper covers every new route
- Reviewed with Dennis

---

## QA checklist

**Automated**

- [ ] Payee validation works for every method, and the API enforces the 24-hour rule
- [ ] Bill statuses change on the right Nairobi dates, including just before and after midnight
- [ ] Recurring schedules are right for the 31st, February, leap years, quarterly and yearly. Running the job twice still leaves one future bill.
- [ ] **Pay all**:
  - 3 bills are each paid once
  - one failure doesn't affect the others
  - a variable bill with no amount is blocked
  - a paid-outside payee is blocked
  - the daily cap applies
- [ ] Payroll:
  - the draft run is created once, 5 days before pay day
  - the cap is enforced
  - a failure is retried for that person only
  - every salary endpoint rejects employees
- [ ] Floats: issuing and topping up each pay once, the balance adds up, and overspending creates a claim for exactly the extra
- [ ] Company spending: marking a bill paid outside creates exactly one record, and saving without a receipt needs a reason
- [ ] Overview totals match the seeded test company, and the cash check flips between Covered and Short
- [ ] Each reminder fires once per stage, on the right day
- [ ] Isolation tests pass on every new route

**Manual** (staging, real phones, small real amounts; record references in Handoff notes)

- [ ] Add one payee for each method. Change one payee's details: every admin gets an email, and paying them within 24 hours asks for a second confirmation.
- [ ] A monthly subscription paid through Expendi, due in 2 days:
  - the reminder arrives
  - pay it, and it shows as paid
  - next month's bill appears
- [ ] A card-only subscription set up as paid outside: the reminder arrives, and marking it paid creates a company spending record.
- [ ] A variable bill (e.g. PAYE to the KRA Paybill): enter the amount and reference, then pay it.
- [ ] Payroll with 3 team numbers:
  - the draft appears, and you adjust one person's pay with a reason
  - Approve & pay all, and each person receives their exact net pay
  - force one failure, and only that person is retried
- [ ] Sign in as an employee: you see only your own salary payments, and calling the API directly shows nobody else's.
- [ ] A float of KES 1,000:
  - the employee records 2 purchases, and the balance is right
  - overspending creates a claim for the extra
  - the admin closes the float
- [ ] The overview matches a hand calculation, and the cash check shows "Short" when the wallet holds less than the 30-day total
- [ ] Every new notification arrives, by push and by email

**Hygiene**

- [ ] Build, typecheck and tests pass; no keys committed; no `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] EXP-305 to EXP-314 are Done in Linear
- [ ] Checkpoint C2 reviewed with Dennis

---

## Handoff notes (fill in before ending each session)

- **Status:**
  - 2026-11-02: started early, in parallel with Phase 2 code (Dennis's decision; see the Phase 2 Handoff notes, "QA deferred"). The Phase 2B gate of Checkpoint B (Till, Paybill, bank, USDC address, payroll cap) hasn't run yet.
  - T34: the API and tests are done (uncommitted); the app screens are in progress.
  - T34–T41 code done (2026-11-02), app screens included. T42 and T43 remain. The Phase 2B live gate (Checkpoint B) and QA haven't run yet.
- **Built:**
  - **T34 payees API:**
    - **Table:** `payees` (migrations 0024/0025), with a check constraint per method and RLS FORCE. The routes are admin only.
    - **Employee payees** link to a same-company membership. On `mpesa_phone`, the phone is never stored: it's resolved at payment time to the confirmed `users.phone`.
    - **USDC payees** must be on the T33 allowlist; addresses must pass EIP-55.
    - **Detail changes:** creating a payable payee or changing its details goes through a passkey challenge (purpose `change_payee`) bound to the exact change. It's audited with masked values, emails every admin and sets `details_changed_at`.
    - **Guards for T37/T39** (`services/payees/payment-guard.ts`): call `resolvePayeeRecipient(tx, payeeId, { secondConfirmation })` inside the payout-prepare transaction. It enforces the 24-hour rule on the database clock and returns the recipient snapshot.
    - **Extra route:** `GET …/payees/banks` (Paycrest's KES banks, for the picker).
  - **T35 bills:**
    - **Tables:** `bills` (migrations 0033/0034). Admin only in the routes AND in row-level security (`app_current_role() = 'admin'`, like `payroll_runs`).
    - **Status job:** `station/bill-status.ts`, lock 72_035, every 15 minutes. It moves only forward, through the definer function `advance_bill_statuses(today)`. Status ticks aren't audited.
    - **Invoices:** images or PDFs through `POST …/bills/upload-url` (claims stay image-only, also enforced by a DB check). The app attaches images only; PDFs need `expo-document-picker`.
    - **Variable bills:** a `variable` flag, with a NULL amount until it's entered.
    - **Seam for T37:** `services/bills/payable.ts` `assertBillPayable` refuses `not_unpaid`, `paid_outside_payee`, `paid_outside_recurring`, `no_amount` and `no_reference`.
  - **T36 recurring payments:**
    - **Tables:** `recurring_items` (migrations 0038/0039). One outstanding bill per item, enforced by a partial unique index over `upcoming`/`due`/`overdue`/`payout_failed`/`paying`.
    - **Job:** `station/recurring-bills.ts`, lock 72_036.
    - **Next bill:** `createNextRecurringBill` makes it. Settling a bill (paid outside, cancelled) creates the next one in the same transaction.
    - **T37 must call `onRecurringBillSettled(tx, bill, now)` when a bill becomes `paid`.**
    - Salary items are left to T38: the unique index would block a payroll bill while the previous one is `payout_failed`.
- **Live payment references (bills, payroll, floats):**
- **Changes from spec or plan, and why:**
  - **T41 company spending:**
    - **Tables:** `paid_from_accounts` (migrations 0040–0042). `expenses.paid_from_account` text became `paid_from_account_id`, a composite FK.
    - **No-receipt reason:** `expenses.no_receipt_reason` (8–300 characters). "No receipt" is computed, not stored.
    - **Bills paid outside:** marking a bill paid outside records exactly one company spending row (`expenses.bill_id`, unique) in the same transaction.
    - **Watch for double counting:** a bill paid outside is both a `paid_outside` bill and a company spending row. T42 (overview) and T44 (Zoho) must skip one; `expenses.bill_id IS NOT NULL` marks it.
  - **T38 salaries and payroll:**
    - **Salaries** are monthly, fixed-amount `salaries` recurring items paid through Expendi, one per payee.
    - **Draft job:** `payroll-drafts`, lock 72_038. It drafts at most 5 Nairobi days before pay day, once per `(organization, pay_date)`.
    - **Cap:** each run's cap is its drafted salaries × (100 + margin)%.
    - **Pay changes** need the admin's passkey (purpose `change_salary`) and email every admin.
    - **Draft adjustments** (amount, leave out, one-off) need reasons and are audited.
    - **Privacy (migration 0045):**
      - Payroll bills, runs and salary items are admin-only in RLS.
      - Employees read only their own paid, paying or failed payroll bills (`GET …/me/salary-payments`).
      - **Phase 1 issue fixed:** payroll `payouts` rows are admin-only.
    - **Seam for T39:** `services/payroll/payable.ts`.
  - **T37 paying bills:**
    - **USD bills:** `bills` and `recurring_items` have `currency` (`kes`/`usd`, taken from the payee's method) and `amount_usdc`. A USD bill pays exactly that USDC; the engine values it in KES for the daily cap.
    - **Pay / Pay all:** up to 20 bills per passkey. Payees changed within 24 hours are refused together until the admin gives a second confirmation.
    - **Shared approval steps:** prepare, reuse or discard, cover check, preview. These moved to `services/payments/payment-approval.ts`, which claims use too.
    - **Bill payout hook:** `bills/bill-payout-hooks.ts` runs the T36 next-bill hook on `paid`.
  - **T39 paying payroll:**
    - **Pay:** Approve & pay all with one passkey, each person their own payout, the run cap enforced by the engine.
    - **Run status:** `draft → paying → paid / partly_failed`, with progress counts. A failed person is retried alone.
    - **Split salaries:** a salary over KES 300,000 splits into several orders (`payouts.subject_part`), and a retry pays only the unpaid parts.
    - **Margin:** changes need a passkey (purpose `change_payroll_margin`), re-cap draft runs and email every admin.
  - **T40 petty cash floats:**
    - **Tables:** `floats` and `float_movements` (migrations 0047/0048).
    - **Issuing:** issues and top-ups are float payouts (pending → paid/failed) to the holder's confirmed number, with a passkey.
    - **Balance:** computed from paid movements minus spending, returns and write-offs; never stored.
    - **Overspend:** splits into the float spending plus a submitted claim for exactly the extra (`expenses.overspend_claim_id`).
    - **Close:** needs a zero balance, or a write-off reason.
  - **Bills to USDC payees are entered in USD (Dennis, 2026-11-02),** and paid exactly that USDC, as USDC payees already work (T33). The overview, cap and export use the KES equivalent at the payment-day rate. T35 built KES-only bills, so this change lands with T37.
  - **`bills` and `recurring_items` (spec §10 updated):**
    - **`bills` columns:** `variable`, `paid_on`, `paid_outside_note`, `cancelled_by`, `cancelled_at`.
    - **`receipt_files`:** `bill_role` (`invoice`/`proof`) and the `pdf` kind.
    - **`recurring_items.next_due_on`:** the bill after the current one; NULL means ended.
    - **`recurring_items.schedule_day`:** the ISO weekday for weekly schedules.
    - **Fixed after creation:** payee, schedule, `starts_on` and `pay_via` can't be changed.
  - **`payees` (spec §10 updated):**
    - `method` is nullable (no payment details yet).
    - USDC payees store no `account_name`; the payee's name is used.
    - Employee `mpesa_phone` payees never store the phone.
- **Environment variables added:**
- **Known issues and TODOs:**
  - **Overspend claims (T40) have gaps in `claims.ts`:**
    - editing one with an SMS receipt fails, because the SMS amount is compared to the extra
    - amount edits aren't blocked
    - the claim view doesn't expose `floatId`
    - a recompute may flag the paired float row as a near-duplicate
  - **A non-payroll bill above Paycrest's per-order maximum (~3,000 USDC) isn't split.** Paycrest answers "rate unavailable" (503).
  - **For T42 (overview) and T44 (Zoho):**
    - Petty cash = float spending + claims with a `float_id`; don't count float payouts as spending as well.
    - A bill paid outside is both a bill and a company spending row (`expenses.bill_id`); count it once.
    - USD bills: use `amount_kes` on the payout once paid, the company-spending row once paid outside, and the live rate while unpaid.
- **QA results (date, who ran it, devices used):**
- **Next session starts with:**
