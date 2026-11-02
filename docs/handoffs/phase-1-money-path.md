# Phase 1 Handoff: Money path

**Linear:** milestone "Phase 1 · Money path"

- EXP-273 (T5) Privy wallet-policy spike
- EXP-278 (T6) Company wallet and deposits
- EXP-275 (T7) Paycrest client and order checks
- EXP-281 (T8) Create and fund a payout
- EXP-285 (T9) Paycrest webhook and reconciliation
- EXP-288 (T10) Failed payouts and retry
- EXP-304 (T33) USDC payouts to allowlisted addresses

**Goal:** prove with real money, before any screens exist, that a company's USDC wallet can pay safely and exactly once:

- exact KES amounts to M-Pesa numbers, Tills, Paybills and Kenyan banks through Paycrest
- USDC to allowlisted addresses

This is the riskiest part of the MVP. **Since the 2026-11-01 scope change, one engine pays every kind of spending:** claims, bills, petty cash floats and payroll runs. Build it general from the start, with batches and caps.

## Start prompt

> Read `docs/handoffs/README.md`, the Handoff notes in `docs/handoffs/phase-0-foundation.md`, then `docs/handoffs/phase-1-money-path.md`. Build Phase 1 one task at a time, in the order listed, reading each task's Linear issue first. Stop at Checkpoint B and run the live payout tests with me.

## Read first

- **Spec:**
  - §5 "Kinds of money out", for what the engine pays
  - §6.7 (Approve & pay), §6.8 (payout failures), §6.9 (wallet)
  - §6.19 (payees and payment methods), §6.20–6.22 (bills, salaries, floats)
  - §7 (money safety: named purposes, caps, payee guard), §11 (fees)
- **Build plan:** Tasks 5–10 and 33
- **Consumer backend** (`/Users/chizaa/Documents/projects/expendi/backend/`):
  - `src/services/paycrest/paycrest-client.ts` and `order-safety.ts`: **port both**
  - `src/services/offramp/`: provider interfaces and routing, for reference
  - `docs/qadi-ramps.md`: the safeguard pattern to copy. It covers idempotency keys, saving the order ID before funding, funding exactly once under row locks, reconciliation, and `needs_review`
  - `docs/provider-offramps-audit.md`: what's live in the consumer app and what isn't
  - The **unmerged Paycrest webhook fix** on branch `fix/paycrest-webhook-v1`, in the worktree at `/Users/chizaa/Documents/projects/expendi/backend-paycrest-rate/`. **Read it before T9.**
  - `src/services/wallet/` (`privy-wallet-actions.ts`, `wallet-service-live.ts`): how Privy server wallets are used
  - `docs/privy-backend-security-deep-dive.md`: **findings not to repeat**. Every signing request must be bound to the owning company's wallet
  - `src/routes/alchemy-webhooks.ts`: the deposit-detection pattern
  - `src/services/transaction-approval/`: the approval-token pattern. Here the confirmation is the admin's passkey (spec §7.3)

## Where things stand

Phase 0 is done; check its Handoff notes. The API has company isolation, the audit log and Privy login (email + passkey; the payout phone is a separate, SMS-confirmed field per spec §6.18).

## Tasks, in order

Start with **T5**, because it decides the wallet policy T6 creates. T7 can run alongside T6.

### T5 · EXP-273: Privy wallet-policy spike

- Answer two questions in `docs/decisions/privy-wallet-policies.md`. Can a policy limit a wallet to `transfer` on the USDC contract only, under a maximum amount? Can the allowlist be updated through the API?
- If amounts **can't** be capped, record the switch to Paycrest's onchain gateway contract (§7), and tell Dennis before T6.

### T6 · EXP-278: Company wallet and deposits

- One wallet per company, safe to retry. Attach the policy from T5.
- USDC on Base is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Check it against Circle's docs.
- Credit deposits only once per transaction hash and log index, and only for the USDC contract, on Base, sent to that company's wallet.

### T7 · EXP-275: Paycrest client and order checks

- **Paycrest has no sandbox.** Unit tests mock the API, and live checks use small real amounts.
- **Rounding:** round the claim up to a whole shilling (M-Pesa only moves whole shillings), and round the USDC up to 6 decimals. Quote again if the amount crosses into a different rate band.
- Paycrest needs the recipient's full name.
- **Every KES channel:**
  - M-Pesa number
  - Till (Buy Goods)
  - Paybill with an account number
  - Kenyan bank account, with bank codes from Paycrest's KES institutions list

  The consumer `order-safety.ts` already checks the channel and the Paybill business number.

- **Record in Handoff notes** (spec §14):
  - Paycrest's maximum per order (salaries may exceed it)
  - settlement times for each channel
  - whether Paycrest checks account names

### T8 · EXP-281: Create and fund a payout

- **Inputs:** the engine takes a company, a subject (`claim`, `bill` or `float`, optionally part of a payroll run), a recipient and a KES amount. **No claims, bills or payroll exist yet.** Drive it with scripts.
- **Recipient snapshot:** copy the recipient onto the payout, so a later payee edit never changes a payment already made.
- **Checks before paying:**
  - the balance
  - the right cap: the **daily cap** for claims, floats and bills, or the **payroll cap** for a run (active salaries plus a margin, 20% by default)
  - the company's pause flag and the platform-wide pause flag

  "Today" for the daily cap means **Africa/Nairobi** time.

- **Batches:** one approval can cover several payouts, for **Pay all** on bills and for payroll runs. The token is bound to the exact set of payouts and their total. Each payout is still funded and failed on its own.
- **Order of operations:** generate a stable idempotency key → save the payout → create the Paycrest order → save the order ID → validate it with `order-safety` → fund once, under a row lock.
- **Approval tokens** are single-use, short-lived, and bound to the amount and recipient.
- Add `apps/api/scripts/test-payout.ts` for the live checks at Checkpoint B.

### T9 · EXP-285: Paycrest webhook and reconciliation

- **Webhook:** verify the signature, then re-fetch the order from Paycrest rather than trusting the webhook body.
- **Reconciliation job:** runs every minute, reads Paycrest and updates our statuses, and never creates orders or sends funds.
- An unclear outcome after funding marks the payout `needs_review`.

### T10 · EXP-288: Failed payouts and retry

- **Refund:** the payout is marked failed and the balance is restored.
- **Retry:** creates a new payout with a new key.

### T33 · EXP-304: USDC payouts to allowlisted addresses

- Create the address allowlist (`withdrawal_addresses`). USDC payees (Phase 2B) and withdrawals (T21) both use it.
- Add a direct-transfer provider (`provider = onchain`). It sends only to that company's allowlisted addresses, enforced in the backend and, if T5 allows it, in the Privy policy.
- Adding or removing an address needs the admin's passkey and is audited.

## Environment variables (suggested names)

| Name                                             | Purpose                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| Privy wallet credentials                         | As the T5 spike requires                              |
| `BASE_RPC_URL`                                   | Base RPC                                              |
| `USDC_BASE_ADDRESS`                              | USDC contract on Base                                 |
| `ALCHEMY_API_KEY`, `ALCHEMY_WEBHOOK_SIGNING_KEY` | Deposit webhooks                                      |
| `PAYCREST_API_KEY`, plus the webhook secret      | Paycrest; see how the consumer code verifies webhooks |

## Exit criteria: Checkpoint B

- 5 real KES payouts to M-Pesa numbers work end to end, including one forced failure that refunds
- One real payment each to a Till, a Paybill, a Kenyan bank and an allowlisted USDC address
- A batch of 3 under one approval, with one forced failure that doesn't affect the others
- Wallet safety is proven: the policy, the `order-safety` checks, the daily cap and the payroll cap
- Reviewed with Dennis before any screens are built

**Split (decided by Dennis, 2026-11-02).** Checkpoint B has two parts:

- **Gate for Phase 2:** the forced M-Pesa failure refunds and its retry pays once, the batch of 3 with one forced failure, and the crash test. These prove the rules Phase 2's Approve & pay depends on. Phase 2 claims pay to M-Pesa numbers, which is already proven live.
- **Gate for Phase 2B:** one real payment each to a Till, a Paybill, a Kenyan bank and an allowlisted USDC address, and the payroll cap. These run alongside Phase 2 and must pass before Phase 2B starts, because bills and payroll use them.

Dennis reviews each part when it passes.

---

## QA checklist

**Automated**

- [ ] Rounding: KES 1,499.50 → 1,500, KES 1,500.00 → 1,500, and USDC never underpays across a table of rates
- [ ] `order-safety` rejects each case: wrong network, wrong token, refund address, expired, memo present
- [ ] The same idempotency key twice gives one order and one transfer
- [ ] A short balance, the daily cap, a company pause or a platform pause each reject the payout, and no order is created
- [ ] A duplicate webhook updates once; a bad signature is rejected and logged
- [ ] A timeout after funding sets `needs_review`, and no second transfer happens
- [ ] A refund marks the payout failed and restores the balance; a retry pays exactly once
- [ ] Deposits: other tokens and other chains aren't credited, and a duplicate deposit webhook credits once
- [ ] Orders build correctly for every channel (M-Pesa number, Till, Paybill, bank), and a channel or business-number mismatch is rejected
- [ ] One approval for a batch of 3 pays each once, and changing any amount invalidates it
- [ ] A payroll run over its cap is rejected, and no order is created
- [ ] A payout or withdrawal to an address that isn't allowlisted is impossible

**Live checks with real money** (use the smallest amounts Paycrest accepts; record every order ID, tx hash and M-Pesa reference in Handoff notes)

- [ ] Create a test company with a script and send about $20 USDC on Base to its wallet. The deposit appears within a minute and the balance matches the chain.
- [ ] 5 payouts to team M-Pesa numbers, one of them with cents (e.g. KES 99.50). Each phone receives the exact whole-shilling amount.
- [ ] Forced failure: a payout to an invalid number refunds, the balance is restored, and a retry to a valid number pays once.
- [ ] One payment each to:
  - a real Till
  - a real Paybill with an account number
  - a Kenyan bank account
  - an allowlisted USDC address

  Each arrives with the right amount and reference.

- [ ] A batch of 3 payouts under one approval, with one forced to fail: the other two arrive, and only the failed one is retried.
- [ ] Set the daily cap to KES 1,000. A KES 1,500 payout is rejected, and no Paycrest order is created.
- [ ] With the pause flag on, the payout is rejected.
- [ ] Sending a non-USDC token, or an over-limit USDC transfer, directly through Privy is blocked by the policy.
- [ ] Kill the process right after funding. Reconciliation ends the payout as paid or `needs_review`, never with a second transfer.
- [ ] The audit log has an entry for every step, and `wallet_transactions` adds up to the on-chain balance.

**Hygiene**

- [ ] Build, typecheck and tests pass; the isolation helper covers the new routes
- [ ] No keys are committed, and no `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] EXP-273, 278, 275, 281, 285, 288 and 304 are Done in Linear
- [ ] Checkpoint B reviewed with Dennis

---

## Handoff notes (fill in before ending each session)

- **Status (2026-11-01):**
  - T5 is done (EXP-273 Done).
  - T6 code is done and tested, including the KES equivalent (EXP-278 In Progress). It is waiting only on the live deposit check at Checkpoint B.
  - T7 is done (EXP-275 Done).
  - T8 is done (EXP-281 Done). Its live payouts happen at Checkpoint B.
  - T9 and T10 are done (EXP-285, EXP-288 Done).
  - T33 is done (EXP-304 Done).
  - **All Phase 1 code is built. Next is Checkpoint B:** the live checks with Dennis (runbook below).
- **Status (2026-11-02):**
  - The API is deployed to Railway (`dev`), and Checkpoint B setup is complete: runbook steps 1–7.
  - Live checks are in progress, split into a Phase 2 gate and a Phase 2B gate (see "Split" under Exit criteria). Results are under "Live payout results".
- **T5 decision (Sender API or gateway contract):** **keep the Sender API.** Privy policies can limit a wallet to USDC `transfer` on Base under a maximum amount, and allowlists can be updated through the API. Proven live with 31 checks; see `docs/decisions/privy-wallet-policies.md`.
  - **Design for T6:**
    - Each wallet is owned by an Expendi management key quorum the API never holds.
    - The API is an additional signer that can't change policies, signers or the allowlist, and can't export.
    - One policy per company allows only `eth_sendTransaction` USDC transfers on Base up to the per-transaction maximum.
    - The allowlist is enforced in the backend (T33).
  - **Decided by Dennis (2026-11-01):**
    - The default per-transaction cap is **3,100 USDC**.
    - **Dennis holds the management key,** ops-only: in a Doppler config the API's token can't read, with an offline backup.
    - **Money approvals use Expendi's own WebAuthn credential** (see T8).
- **Built:**
  - **T5:** `apps/api/scripts/spike-privy-policy.ts`. It is re-runnable, and each run leaves one empty wallet nobody can use. `apps/api/tsconfig.json` now includes `scripts/`, so scripts are typechecked and linted.
  - **T6, tables (migrations `0007_wallets`, `0008_wallets_rls`):**
    - **`wallets`:** one per company. It stays `creating` until its Privy policy and wallet both exist, then becomes `active`. It stores `per_transaction_max_usdc` (the cap in its Privy policy) and `deposits_watched_at`.
    - **`wallet_transactions`:**
      - an append-only ledger with signed amounts (credits positive, debits negative), so the balance is `SUM(usdc_amount)`
      - unique per `(lower(tx_hash), log_index)` across all companies
      - a composite FK `(wallet_id, organization_id)`, so a row can't point at another company's wallet
      - a trigger that rejects UPDATE, DELETE and TRUNCATE for every role, the owner included
    - **Row-level security:**
      - `wallets` is ENABLE, not FORCE. As with `audit_log`, the owner runs `active_wallets_by_address(text[])`, a `SECURITY DEFINER` function that resolves only the addresses it's given.
      - `wallet_transactions` is ENABLE and FORCE.
  - **T6, wallet creation:** `ensureCompanyWallet` (`services/wallet/company-wallet.ts`). Each step resumes on retry:
    1. the row, unique per company
    2. the Privy policy, created with idempotency key `wallet-policy-<row id>`, then saved
    3. the Privy wallet, found by `external_id` = company ID if an earlier attempt created it, otherwise created with key `wallet-<row id>`. It's checked for owner = management quorum, exactly our policy, and the runtime signer; anything else is a `WalletMisconfigured` error and the row stays `creating`.
    4. activation, audited as `wallet.created`
    5. the Alchemy webhook told to watch the address
  - **T6, policy:** built by `services/wallet/wallet-policy.ts`. Its one rule is `eth_sendTransaction` → USDC on chain 8453, with `transfer.amount` ≤ the cap.
  - **T6, deposits:** `POST /webhooks/alchemy` (`routes/alchemy-webhooks.ts`) with `services/wallet/deposits.ts`.
    - The HMAC is checked, and only `BASE_MAINNET` deliveries count.
    - The delivery is only a trigger: amount, sender, recipient and log index all come from the receipt (`eth_getTransactionReceipt` on `BASE_RPC_URL`). Only Transfer logs from the USDC contract in successful transactions are credited.
    - Each credit happens in its company's scope and is audited as `wallet.deposit_received`.
    - A missing receipt or an RPC failure returns 500, so Alchemy retries.
  - **T6, balance:** `GET /organizations/:id/wallet` is admin only (new `requireRole` middleware). It returns `{ address, chain, usdcBalance }` from the ledger.
  - **T6, shared and refactors:**
    - The Privy client is shared (`services/privy/privy-client.ts`), and `PrivyAuthLive` now uses it.
    - `makeAppLayer` takes an `ExternalLayers` record. `makeTestRuntime(overrides)` fakes every provider (`__tests__/helpers/fakes.ts`).
  - **T6, scripts:**
    - `scripts/setup-privy-keys.ts --env <name>` creates the management and runtime key quorums. Private keys go only to a git-ignored 0600 file.
    - `scripts/create-test-company.ts --name … --admin-email …` sets up the Checkpoint B company and its wallet.
  - **T7, Paycrest** (`services/paycrest/`):
    - **`paycrest-client.ts`:** the consumer v2 client as an Effect `Paycrest` port: `rate`, `institutions`, `verifyAccount`, `createOrder`, `getOrder`.
      - Responses are parsed with zod; more than 6 decimals is rejected, never rounded.
      - A transport error, 5xx or unreadable reply to an order is flagged `ambiguous`: the order may exist.
    - **`amounts.ts`:** bigint-only money arithmetic.
      - `roundUpToWholeShilling`: KES 1,499.50 → 1,500.
      - `usdcCovering`: the least USDC that converts to at least the payout, rounded up.
      - `kesCentsFor`: rounded down, for display.
    - **`quote.ts`:** `quoteKesPayout`. A 1 USDC probe rate sizes the order, then it re-quotes at the real size, then once more if the size changed the rate band (at most 3 rate calls). The minimum is 0.5 USDC.
    - **`recipient.ts`:** `toPaycrestRecipient` for the 4 KES methods.
      - M-Pesa number, Till and Paybill all use `SAFAKEPC`, with channel `Mobile`, `Till` or `Paybill`.
      - A Paybill's account reference is the identifier, and its number is `businessNumber`.
      - A bank uses its code from `GET /institutions/KES`, which lists 39 banks, 1 SACCO and M-Pesa/Airtel.
      - A name is always required.
    - **`order-request.ts`:** builds the order: `amountIn: "crypto"`, the quoted rate, `reference` = payout ID, `refundAddress` = the company wallet.
    - **`order-safety.ts`:** `checkOrder`, ported from `assertSafeDeposit`, returns `unsafe`, `quote_changed` or `over_approved_debit`.
      - **Stricter than the consumer:** no 0.01 KES tolerance. `amount × rate` must cover the whole-shilling payout, or it's `quote_changed`.
      - **Channel and Paybill business-number checks** apply to every M-Pesa method.
  - **T7, wallet:** `GET /organizations/:id/wallet` now returns `kesEquivalent: { kesCents, rate }` at Paycrest's marginal rate, or `null` when Paycrest is down.
  - **T8, tables (migrations `0009_payouts`, `0010_payouts_rls`):**
    - **`payouts`** (RLS FORCE):
      - The recipient is snapshotted as jsonb, and the amount is in whole shillings.
      - It stores `quoted_rate`, `quoted_usdc` and `max_debit_usdc` (what the approval binds), the Paycrest order fields, `order_requested_at`, `funding_started_at`, `privy_transaction_id`, `tx_hash` and `failure_reason`.
      - Status: `awaiting_approval → approved → order_created → funding → paying → paid`, plus `failed` and `needs_review`.
      - `idempotency_key` is unique per company, and there is one non-failed payout per subject (partial unique index).
      - Composite FKs link it to the wallet and the payroll run.
    - **`payroll_runs`:** minimal, so the payroll cap comes from the database. RLS admits admins only (`app.role`). T38 adds drafting and the cap formula.
    - **`approval_passkeys`** (RLS on `app.user_id`) and **`webauthn_challenges`** (user, plus company for approvals; single-use via `used_at`).
    - **`platform_settings`:** one row, the platform-wide pause. The app role can only read it.
    - **`wallet_transactions.payout_id`:** a payout debit must name its payout, and each payout is debited at most once.
  - **T8, approvals** (`services/approval/passkeys.ts`):
    - Own WebAuthn credentials via `@simplewebauthn/server` 13. Enrolment allows only a first passkey; a replacement goes through support.
    - The approval challenge is SHA-256(nonce ‖ intent hash), single-use and valid for 5 minutes. It is spent before the signature is checked, so a failed attempt can't be retried.
    - The counter guards against cloned authenticators.
    - `scripts/lib/software-passkey.ts` is a software authenticator used by tests and the Checkpoint B script.
  - **T8, engine** (`services/payout/`):
    - **`preparePayouts`:**
      - validates the recipient (and bank codes against Paycrest's list), quotes, and records `awaiting_approval`
      - the same key returns the same payout; a key reused for something different is refused
      - `max_debit = quote + 0.25 USDC + 0.5%`, to cover Paycrest's fee and rate drift. **Calibrate it at Checkpoint B.**
    - **`requestPayoutApproval`:** active admins only. It returns the passkey options plus the total KES and maximum USDC.
    - **`approvePayouts`:**
      1. Verify the passkey.
      2. In one transaction holding the company wallet row lock (so concurrent approvals queue), check the intent hash still matches, then the company and platform pauses.
      3. Check the balance: ledger minus what's promised to `approved/order_created/funding/needs_review` payouts.
      4. Check the payroll run's cap (all payouts in the run that haven't failed) or the daily cap (approvals since Nairobi midnight, payroll excluded).
      5. Mark the payouts approved, audited.
      - A rejection is audited in its own transaction.
    - **`fundPayout`:**
      1. A fresh quote (if the rate moved past the approved maximum it fails before ordering).
      2. Under the row lock, record `order_requested_at`.
      3. `createOrder` with reference = payout ID. An ambiguous reply → `needs_review`; a definite one → `failed`.
      4. Save the order, then `checkOrder`.
      5. Under the lock, re-check (pause, order safety, deposit window) and record `funding_started_at`.
      6. `sendUsdc`: Privy `eth_sendTransaction`, sponsored, idempotency key `payout-<id>`, signed with the runtime key. A refusal → `failed`; unknown → `needs_review`; success → `paying` with the ledger debit of the exact `amountToTransfer`.
      - Every step is audited.
    - **`approveAndPay`:** approves, then funds each payout on its own. One failing, even with a defect, never stops the others.
  - **T8, scripts:** `scripts/test-payout.ts enrol | pay --batch file.json | status`, covering every method and payroll runs.
  - **Tests:** 286 in total (41 for T8).
    - Ten engine mutation checks each failed their test: no balance check, no daily cap, no payroll cap, no pause check, no intent check, no wallet lock, no order check, an unknown send treated as refused, an ambiguous order treated as refused, and the amount left out of the intent.
    - The wallet-lock check is a 6-admin concurrent stress test. It failed under mutation 3 of 3 times and passed 5 of 5 without it.
  - **T9, sync** (`services/payout/sync.ts`):
    - **`syncPayoutOrder`** applies an order _freshly fetched from Paycrest_ to its payout, under the payout's row lock, forward-only, so a duplicate or stale delivery changes nothing:
      - `paying`: validated/settling/settled → `paid` (with `paidAt` and `provider_reference`, the M-Pesa receipt); refunded → `failed`; expired/cancelled → `needs_review`
      - `funding`: Paycrest has our deposit (deposited and onward, or refunded) → `paying`, recording the ledger debit, and on to `paid` in the same sync; expired → `needs_review`; no outcome after 10 minutes → `needs_review`
      - `order_created` (never funded): expired, or initiated past the deposit window → `failed`, nothing sent
      - `needs_review` is never changed automatically; Paycrest's latest status is only recorded (`provider_status`, `provider_checked_at`)
    - **`reconcilePaycrestPayouts`:** every unfinished Paycrest payout, least recently checked first, each isolated. It also settles approvals left without an order:
      - no order was requested after 15 minutes → `failed` (nothing sent; the reservation is released)
      - an order was requested but there's no order ID after 2 minutes → `needs_review`
      - **It never creates an order or sends money** (tested).
  - **T9, webhook:** `POST /webhooks/paycrest` (`routes/paycrest-webhook.ts`).
    - The `X-Paycrest-Signature` HMAC (`PAYCREST_API_SECRET`) is checked first; a bad one gets 401 and is logged.
    - **Any `webhookVersion`, with `data.direction` optional.** This is the consumer's unmerged `fix/paycrest-webhook-v1` lesson: real deliveries are v1 with no direction.
    - Non-offramp orders are ignored. The order is re-fetched and synced; a fetch failure returns 500 so Paycrest retries.
  - **T9, lookups (migrations `0011`, `0012`):** `payout_by_provider_order` and `paycrest_payouts_to_reconcile` are `SECURITY DEFINER` functions returning IDs only. They work through an owner-only SELECT policy on `payouts`.
  - **T9, job runner:** `src/station/scheduler.ts` runs each job every minute in every API instance. A Postgres advisory lock means only one instance does the work, and a run never overlaps itself. `reconcile-paycrest` (lock key 72001) starts with the server and stops cleanly on shutdown.
  - **T10, refunds:** an incoming USDC transfer _from a payout's own Paycrest deposit address_ is recorded as a `refund` ledger row linked to that payout (`wallet.refund_received`). The balance comes back from the chain, never from Paycrest's status, so a refund can't be counted twice. Paycrest keeps its `transactionFee` on a refund (its docs: the refund is `amount + senderFee`).
  - **T10, retry:** `retryPayout` (`services/payout/retry.ts`) works only on a `failed` payout. It creates a new payout for the same subject and amount, with a new idempotency key and optionally a corrected recipient. The new payout waits for a fresh passkey approval.
  - **T9/T10 scripts:** `test-payout.ts` adds `retry` and `reconcile`.
  - **Test isolation:** tests that flip platform-wide state (the global pause) run alone as `*.serial.test.ts` (`vitest.serial.config.ts`). `pnpm test` runs both suites. The pause test, run in parallel, had been failing payouts in other files.
  - **Tests:** 311 in total (309 main + 2 serial; 24 for T9/T10). Seven T9/T10 mutation checks each failed their test: no webhook signature check, no debit on funding → paying, an unknown order request treated as failed, refunds not classified, expired-after-send treated as failed, trusting the delivery's status, stuck funding never reviewed.
  - **T33, allowlist** (`services/allowlist/allowlist.ts`, `routes/allowlist.ts`, migrations `0013`, `0014`):
    - `withdrawal_addresses` is company-scoped with RLS FORCE. Addresses are lowercased, unique while active, and soft-deleted.
    - Adding or removing an address works like a payout approval: a passkey challenge (purpose `change_allowlist`) bound by hash to the exact change. The change is sent again with the signature and must match.
    - Audited as `withdrawal_address.added` / `.removed`.
    - Routes, admin only: `GET /organizations/:id/withdrawal-addresses`, `POST …/changes`, `POST …/changes/:challengeId/confirm`.
  - **T33, onchain provider** (`services/payout/onchain.ts`):
    - A `UsdcPayoutRequest` pays an exact USDC amount to `{ method: "usdc", address }`, with `provider = onchain`.
    - **The allowlist is checked three times:** at preparation, at approval (under the wallet lock), and at the funding barrier (under the payout lock). A removed address fails the payout with nothing sent.
    - The same funding barrier and single send as Paycrest payouts, but no order. The ledger debit is the exact amount.
    - The `confirm-onchain` station job (lock 72002) marks it `paid`, with `provider_reference` = tx hash, once the receipt shows that exact USDC moving from the wallet to the address. A revert, any other transfer, or no hash after 10 minutes → `needs_review`.
  - **T33, shared changes:**
    - `preparePayouts` now refuses any payment whose maximum debit exceeds the wallet's per-transaction cap (`over_transaction_cap`), so it's refused clearly before the Privy policy would.
    - Refund classification now only counts **Paycrest** deposit addresses. USDC coming back from an allowlisted address the company owns is a deposit.
    - `lockPayout` and `isPaused` moved to `services/payout/guards.ts`.
  - **T33 scripts:** `test-payout.ts allow --address … --label …`, and batch entries with `{ "usdc": "1.5", "recipient": { "method": "usdc", … } }`.
  - **Tests:** 328 in total (326 main + 2 serial; 17 for T33). Seven T33 mutation checks each failed their test: no allowlist check at preparation, approval or funding; any receipt counted as paid; any payout address counted as a refund source; the allowlist change not bound to the signature; no per-transaction cap check.
  - **Earlier tests:**
    - **T6:** 65 tests. Mutation checks failed the expected tests for accepting another token, skipping deduplication, skipping the signature check, skipping `external_id` adoption, skipping the owner check, and dropping the admin check.
    - **T7:** 77 tests. Eight Paycrest mutation checks each failed the expected tests: no coverage check, deposit address = own wallet, no expiry window, memo allowed, no max-debit check, USDC rounded down, no band re-quote, 5xx not ambiguous.
- **Checkpoint B runbook** (run with Dennis; record every result below):
  1. **Keys:** `pnpm --filter @expendi-business/api exec tsx scripts/setup-privy-keys.ts --env dev`.
     - Put the runtime private key in the API's config as `PRIVY_RUNTIME_AUTHORIZATION_KEY`.
     - Dennis stores the management key, ops-only.
     - Set `PRIVY_MANAGEMENT_QUORUM_ID` and `PRIVY_RUNTIME_SIGNER_ID`.
  2. **Privy:** turn on gas sponsorship for Base for server wallets.
  3. **Alchemy:** create an Address Activity webhook on `BASE_MAINNET` pointing at `<api>/webhooks/alchemy`. Deploy, or use a tunnel for local. Set `ALCHEMY_WEBHOOK_ID`, `ALCHEMY_WEBHOOK_SIGNING_KEY`, `ALCHEMY_NOTIFY_TOKEN` and `BASE_RPC_URL`.
  4. **Paycrest:** set `PAYCREST_API_KEY` and `PAYCREST_API_SECRET`, and point the dashboard webhook at `<api>/webhooks/paycrest`.
  5. **WebAuthn:** set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS`. Any values work for the software passkey, e.g. `business.expendi.app` and `https://business.expendi.app`.
  6. **Test company and passkey:**
     - `scripts/create-test-company.ts --name "Expendi Test Co" --admin-email <email>`
     - then `scripts/test-payout.ts enrol --organization-id <id> --admin-email <email>`
  7. **Deposit:** send about $20 USDC on Base to the printed address. **Check:** it appears in `GET /organizations/:id/wallet` within a minute, and the balance matches the chain.
  8. **Payouts:** `scripts/test-payout.ts pay … --batch <file>` for each line of the live QA checklist:
     - 5 M-Pesa payouts, one with cents
     - a forced failure to an invalid number, then `retry --recipient …`. **Check the refund's on-chain sender.**
     - a Till, a Paybill and a bank
     - `allow`, then one USDC payout
     - a batch of 3 with one forced failure
     - the daily cap: set it to KES 1,000, then try KES 1,500
     - the company pause
  9. **Wallet policy:** with the runtime key, `privy.wallets().ethereum().sendTransaction` a non-USDC token and an over-cap USDC transfer from the funded wallet. Both must be refused (`policy_violation`).
  10. **Crash test:** kill the process right after funding starts. `scripts/test-payout.ts reconcile` must end the payout `paid` or `needs_review`, never with a second transfer.
  11. **Calibrate:** compare the real Paycrest `transactionFee` with `maxDebitFor` (0.25 USDC + 0.5%), and record settlement times per channel.
- **Live payout results (order IDs, tx hashes, M-Pesa references):**
  - **Setup (2026-11-02):**
    - Railway project `expendi-business`, environment `dev`: service `api` at `https://api-dev-dcdc.up.railway.app`, deployed from `main` by `railway.json` (migrations run before each deploy), and a private Postgres.
    - Secrets in Doppler `expendi-business`/`dev`. Railway holds only `SECRETS_MANAGER` and `DOPPLER_TOKEN`.
    - Privy `dev` key quorums: management `sf5qdamyq7y247z9y8e40d7z`, runtime `clz9de5fmdgfrx7ehs3gvqht`.
    - Alchemy webhook `wh_mljam5zi5emrcdk4` (Base mainnet) → `/webhooks/alchemy`.
    - Test company "Expendi Test Co" `3881397e-cff4-4904-aa96-5fa0a8529a7d`, admin `hello@cradlelabs.io` (software passkey), wallet `0x69685f698F002120af8185722A3C364A265BD0C3` (Privy `dvmrt90q0c1bf4sm5vihb1g9`).
  - **Deposits:** the ledger matched the chain after every step.
    - 2.020359 USDC, tx `0x6e3fc1a7c4ef744bb9d9a32433657ed2ab78be8b08a162b364b054da6c0ff890` (log 171, block 53389679). Alchemy's delivery was lost: the webhook URL had a trailing `.`, so the API answered 404. Credited by one signed replay of the delivery; a second, identical replay credited nothing.
    - 1.010180 USDC, tx `0x651d2a0e3eb2c72777c25474e4597c087a4adaea5022580dc24abf494a22957d` (log 486). Credited by Alchemy's own delivery within a minute.
  - **M-Pesa payouts** (rate 128.69 KES/USDC):
    1. `63b0ed94-834f-4aa2-ae19-3425d0c62c3e`: KES 100 to +254743312265 (Dennis Kimathi). Order `02a96397-8558-483e-b796-fa6d9f1362f6`: 0.777062 + 0.02 fee = 0.797062 USDC, Gateway settlement tx `0xb25342b1566f557c1f7178a2ef359f9c0a6b0aea4600124dc8d9dba4d1a6078e` (the aggregator's call that pays the provider and treasury; not our funding transfer). Paid 35 s after funding; Dennis confirmed receipt.
    2. `ff34b366-cc6a-4958-a48b-3853dab141cf`: KES 100 to the same number, order `fa5d9b81-bf5a-4761-9564-37d587cd81a4`. Paid. Sent by mistake: a shell error skipped the cap change before the daily cap check.
    3. `e7a3189b-93a4-4498-b8de-70cfc1470dab`: forced failure, KES 99.50 (rounded to 100) to +254700000000, order `c0bc8726-30a8-4638-9f4f-4c5e8bc2ab02`, funded 0.797062 USDC. Paycrest refunded it 32 minutes after funding, and the payout ended `failed`. The refund was 0.777062 USDC (Paycrest kept its 0.02 fee), tx `0x2cf51a57c72d3a1e9a8c4e4797e9aa97d573f23b8489a7c5d37adc44ae61240d`, **sent from Paycrest's Gateway contract** `0x30f6a8457f8e42371e204a9c103f2bd42341dd0f`, not from the order's deposit address. So it was credited as a `deposit`, not as a `refund` linked to the payout. The balance stayed right: ledger = chain = 1.416415 USDC.
       - **Paycrest's `transactionLogs` (UTC):**
         - 21:48:26 `crypto_deposited`
         - 21:48:33 `order_created`, with `gateway_id` `0xe5f673d6acc1f3f317e121ad1c35835e3d5fc512ef1187ee757b75b0ef7835b0`
         - 21:49:12 `order_cancelled`
         - 22:20:28 `order_refunding`
         - 22:20:35 `order_refunded`
         - The refund log carries the same `gateway_id`, which is how a refund can be linked to its payout.
       - **The order was missing from Paycrest's API during the refund.** Between the cancellation and the refund, `GET /v1|v2/sender/orders/:id` returned 404 "Payment order not found", seen at ~22:02. Afterwards it came back as `refunded`, with `txHash` = the refund tx. This is why reconcile treats a 404 like any other fetch error (see Changes from spec or plan).
    - No M-Pesa references: Paycrest returns `paymentReference: null` for settled M-Pesa orders.
  - **Top-up:** 1.01018 USDC, tx `0xdcfcaf4d2d11edce7e2e7a81b522b57a6cd86b4749065ec56b1d36f3f62cee80` (22:24:43 UTC), credited by Alchemy. Ledger = chain = 2.426595 USDC.
  - **Batch of 3 under one approval** (2026-11-01, Phase 2 gate). KES 65 each = 0.50509 + 0.02 fee = 0.52509 USDC; 2.272848 USDC reserved.
    1. `d59be8a4-8f8c-424e-b070-c232cf804de9` to +254743312265, order `15923db8-b7b8-4043-8658-668a14f1d780`: paid 70 s after funding. Dennis confirmed receipt.
    2. `8cbfbc6c-00a4-4417-ba9d-a7e76b73abe0` to +254743312265, order `856f381f-77b7-4624-a88d-0cb310180f4a`: paid 62 s after funding. Dennis confirmed receipt.
    3. `ce7dd771-0694-4517-9d47-93d99acec044` to +254700000000 (forced failure), order `3e5a98fe-2e43-4b2a-95cc-31cb92f9a143`. Paycrest returned 404 for it again between the cancellation and the refund (22:31–23:02).
       - **The refund:** 0.50509 USDC from the Gateway, tx `0x0a18a3a28f0385de37b237e79472bb099f2eada6612659b3322f2824c64678fd`, at 23:02:32. That was 31.5 minutes after funding, and it was credited as a `deposit`.
       - **The payout:** `paying → failed` at 23:02:43.
    - The forced failure didn't hold up the other two.
    - **Retry, which pays once:** `99a0d41b-1b38-49ef-a632-642e5b463130` (retry of `ce7dd771`, new key) to +254743312265, order `5814e123-589f-4044-954d-713c9ea5acb9`.
      - It was paid at 23:04:06, about 60 s after funding, and Dennis confirmed receipt.
      - The claim has exactly two payouts, one `failed` and one `paid`.
      - This retry stands in for retrying `e7a3189b`, because the balance allowed only one retry.
  - **Crash test (passed):**
    - `feedcfae-c9c7-4397-a209-23c4ad1f475b`: KES 65 to +254743312265, order `1043858f-93ba-4ef0-9f71-cbdc908aa312`.
    - The `pay` process was SIGKILLed 536 ms after `funding_started_at` (23:04:51.071), before Privy returned a transaction.
    - No transfer reached the deposit address `0xeDC8f461B99EC738Dc5fce35CeE2ef38E03B9696`, and Paycrest stayed `initiated`.
    - The new reconcile, run locally at 23:05:50, left it alone (inside the 10-minute window).
    - The deployed reconcile job moved it to `needs_review` at 23:15:27: "Funding started but no outcome was recorded."
    - There was no ledger debit and no second transfer. Ledger = chain = 0.831325 USDC.
    - **Still open:** it's in `needs_review` and reserves 0.757616 USDC until a person closes it. Its order expires at 00:04:49 UTC; after that, close it by hand as `failed`, since nothing was sent. There's no tooling for this before T24.
  - **Phase 2 gate: passed.** All four checks pass:
    - the forced failure refunds
    - a retry pays once
    - in a batch of 3 under one approval, one forced failure doesn't affect the others
    - the crash test ends in `needs_review` with no second transfer
  - **Settlement times:** M-Pesa number, 35–70 s after funding. A failed M-Pesa payout is cancelled within about 1 minute, and the refund arrives about 31 minutes after funding.
  - **Safety checks:**
    - **Daily cap:** passed. Cap KES 250 with KES 200 paid today, then KES 100: refused (`daily_cap`), no Paycrest order, audited.
    - **Company pause:** passed. Refused (`paused`), no Paycrest order, audited.
    - **Privy policy:** passed for every target that isn't USDC. With the runtime key, another token's transfer and a 0-ETH send were refused with `policy_violation`. A USDC transfer above 3,100 can't be shown with `sendTransaction` at this balance, because Privy's simulation fails first. The T5 spike covers that rule.
- **Changes from spec or plan, and why:**
  - **USDC payee amounts are exact USDC** (recorded in spec §6.19), with a KES equivalent for the cap and reports. Whether bills to USDC payees are entered in USD is decided in T35.
  - **Withdrawals (T21) aren't a payout subject yet.** They must go through the same onchain path (allowlist checks, passkey approval, funding barrier). T21 adds a `withdrawal` subject type, or a sibling flow over `fundOnchainPayout`.
  - **T8's approval token is the approval challenge row.** It is single-use, valid for 5 minutes, and bound by hash to the exact payouts, recipients and amounts. A WebAuthn assertion over it approves the batch in the same request, so no separate bearer token can be stolen and replayed.
  - **`needs_review` is a payout status,** not a separate flag (spec §10 lists both). Each payout is then in exactly one state.
  - **`payroll_runs` arrived early** (minimal) so the payroll cap is enforced from the database, not trusted from the caller.
  - **T8 has no HTTP routes yet.** Approve & pay routes come with the claim flow (T19), and passkey enrolment routes with the app (T11/T19). The engine is driven by `scripts/test-payout.ts` until then, as the plan intends.
  - **USDC's address is a code constant** (`services/chain/base.ts`), not the suggested `USDC_BASE_ADDRESS` env var, so a misconfigured environment can't credit or send another token. Checked against Circle's list.
  - **Deposits are credited from receipts,** not from Alchemy's payload. This is the same "re-fetch, don't trust the body" rule T9 applies to Paycrest.
  - **`transactionFeePayer: "customer"`, as in the consumer.** Per Paycrest's docs it only decides who absorbs _our_ sender fee. With none, the deposit is `amount + transactionFee` either way, and the KES isn't reduced. Order-safety enforces `senderFee == 0` and exactly that deposit.
- **Environment variables added:**
  - **Required:**
    - `PRIVY_MANAGEMENT_QUORUM_ID`, `PRIVY_RUNTIME_SIGNER_ID`
    - `BASE_RPC_URL`
    - `ALCHEMY_WEBHOOK_ID`, `ALCHEMY_WEBHOOK_SIGNING_KEY` (comma-separated for rotation), `ALCHEMY_NOTIFY_TOKEN`
    - `PAYCREST_API_KEY`
    - `PRIVY_RUNTIME_AUTHORIZATION_KEY` (the runtime signer's private key)
    - `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` (approval passkeys)
    - `PAYCREST_API_SECRET` (webhook signatures)
  - **Optional:**
    - `WALLET_PER_TRANSACTION_MAX_USDC` (whole USDC, default 3100)
    - `PAYCREST_BASE_URL` (default `https://api.paycrest.io/v2`)
  - **The API won't start without the required ones,** locally too. Fill them in from `.env.example`.
- **Paycrest findings for spec §14 (T7, 2026-11-01):**
  - **Live, from public endpoints:**
    - The KES sell rate is 128.68, the same at 10 and 1,000 USDC.
    - `GET /v2/markets` shows two KES providers. Their minimum is 0.5 USDC and their maximums are 1,500 and 3,000 USDC. One had only KES 1,940 of liquidity.
    - A rate request for 20,000 USDC returns "no provider available". **So one order tops out around 3,000 USDC (about KES 386,000).**
    - `refundTimeoutMinutes` is 2.
  - **From the docs:**
    - Settlement time per channel isn't documented. Measure it at Checkpoint B.
    - Recipient name: `verify-account` returns `"OK"` for KES M-Pesa with no name, and a name check before payout isn't documented. We always send our `accountName`.
    - `reference` uniqueness isn't documented, and senders can't list orders by reference. So an ambiguous `createOrder` can't be resolved by searching on our reference (T8/T9 design).
    - A refund returns `amount + senderFee`; the `transactionFee` isn't returned (T10).
    - Webhooks: `X-Paycrest-Signature`, HMAC-SHA256 of the raw body with the API secret, hex. Retries run with backoff for 24 hours (T9).
  - **Decision for Dennis:** the 5,000 USDC Privy per-transaction cap is above Paycrest's ~3,000 per order. A KES payout can't use the headroom, but USDC payees and withdrawals could. Options: lower the default to ~3,100, or keep 5,000 for USDC payouts.
- **Known issues and TODOs:**
  - **An approved payout whose funding never started** is released by reconciliation after 15 minutes (`failed`, nothing sent), and the admin retries. There's no automatic resume, deliberately: the job never orders or sends.
  - **Refunds come from Paycrest's Gateway contract (confirmed at Checkpoint B, 2026-11-02).** Refunds are recognised by the sender being the payout's Paycrest deposit address, but the real refund came from the Gateway `0x30f6a8457f8e42371e204a9c103f2bd42341dd0f`. **Fixed 2026-11-02 (uncommitted at the time of writing):** a Gateway transfer is a `refund` linked to its payout when the same receipt has the Gateway's `OrderRefunded(uint256 fee, bytes32 indexed orderId)` event right after the transfer (topic0 `0x0736fe42…828e`).
    - **How the payout is found:** first by the payout's `gateway_order_id`, which sync saves once from Paycrest's `transactionLogs`.
    - **Fallback, when the refund arrives before sync** (as both live refunds did): by reading the order from the Gateway itself (`getOrderInfo`). Its `sender` must be the payout's deposit address, its `amount` the payout's USDC, and its `refundAddress` this wallet.
    - Anything that can't be matched is still credited as a `deposit` with a warning. The balance is always right.
    - Code: `services/paycrest/gateway.ts` and `services/wallet/deposits.ts`; migration `0026`.
  - **`needs_review` has no resolution tooling yet.** Ops resolve by hand against Paycrest and the chain. The internal admin app (T24) should add it.
  - **Salary privacy for payouts:** `payouts` rows from payroll runs are visible to any company scope. T39 should restrict them to admins in RLS, as `payroll_runs` already is, keeping the reconciliation job's access in mind.
  - **Passkey enrolment security:** only a first passkey can be enrolled. A stolen session for an admin who hasn't enrolled could enrol one. Mitigations for T19: require a recent login, and email every admin on enrolment.
  - **Reorgs aren't reversed.** A reorged-out transfer is only logged as an error; Base reorgs are rare. The Checkpoint B check that the ledger matches the chain covers it.
  - **No backfill job yet.** If Alchemy stops delivering, deposits wait. T9's minute job could also scan USDC Transfer logs to company wallets.
  - **One Privy app for every environment.** Dev and production share the Privy app, so their key quorums must differ. Keep production's management key out of dev.
  - **Found at Checkpoint B (2026-11-02), not yet changed:**
    - **The fee buffer is too large.** Paycrest's real `transactionFee` was 0.02 USDC on a 0.777 USDC order, but `maxDebitFor` reserved 1.030948 USDC for a payout that cost 0.797062. Decide a smaller buffer (runbook step 11).
    - **The funding tx hash isn't saved.** A sponsored Privy send returns no hash, so the payout and its ledger debit carry only `privy_transaction_id`. Paycrest's order has the hash (`txHash`); sync could fill it in.
    - **No M-Pesa receipt.** Paycrest's `paymentReference` is null for settled M-Pesa orders, so `provider_reference` stays empty.
    - **Runbook step 9:** Privy's `sendTransaction` reports a simulation failure before the policy result. To see `policy_violation`, use `signTransaction` or a transaction that would succeed on chain.
    - **A wrong Alchemy webhook URL fails silently.** The API answers 404 and nothing is logged, and with no backfill the deposit waits. Check the URL character by character. A missed delivery can be replayed with a body signed by `ALCHEMY_WEBHOOK_SIGNING_KEY`.
  - **Database access:** Railway Postgres has no public address. From a Mac, `npx -y @railway/cli@5.71.0 connect Postgres -e dev --tunnel-only -P 55432` opens an SSH tunnel; it needs your SSH key registered (`railway ssh keys add`). Railway CLI 4.27 has no tunnel.
- **QA results (date, who ran it):**
  - 2026-11-01, Claude: automated QA passed: 328 tests (326 main, 2 serial), plus build, typecheck and lint.
  - 2026-11-02, Claude with Dennis: the Phase 2 gate passed (see "Live payout results").
- **Next session starts with:**
  1. **Dennis reviews the Phase 2 gate results.**
  2. **Close `feedcfae` by hand as `failed`** once its Paycrest order has expired (00:04:49 UTC). Nothing was sent.
  3. **The Phase 2B gate:** Till, Paybill, bank, allowlisted USDC address, and the payroll cap. It needs more USDC: the wallet holds 0.83 USDC, with 0.76 of it reserved by `feedcfae` until it's closed. It must pass before Phase 2B.
  4. **Mark EXP-278 (T6) Done in Linear.** Auto mode blocked Claude from doing it.
