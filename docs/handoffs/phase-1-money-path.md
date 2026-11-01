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

- **Status:**
- **T5 decision (Sender API or gateway contract):**
- **Built:**
- **Live payout results (order IDs, tx hashes, M-Pesa references):**
- **Changes from spec or plan, and why:**
- **Environment variables added:**
- **Known issues and TODOs:**
- **QA results (date, who ran it):**
- **Next session starts with:**
