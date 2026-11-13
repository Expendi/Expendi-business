# Confidential accounts, Phase 2 (money in): design

**Status:** built 2026-11-13 as designed, with the changes in the last section.

Jobs live in `apps/api/src/station/`, not `src/services/station/` as the brief said.

Seven findings change the brief; details are in B and E.

1. **`openCompanyQuote` does not fit a move-in.** Every other purpose has its own open function; `advanceCompanyQuote` fits with one condition changed.
2. **`intent_quotes_intents_side_matches_purpose` needs no change in Phase 2.** The check that would break a move-in is `intent_quotes_send_is_from_company_wallet`: it rejects linking the company wallet send to a `move_in` quote, after the USDC has left.
3. **Three `wallet_transactions` checks reject a deposit with no chain transaction.**
4. **A quote reaches `succeeded` through three code paths**, one of them staff's. The credit therefore has to be a separate idempotent step, not part of one transition.
5. **Staff code cannot obtain a 1Click session.** `internal-routes.test.ts` forbids `/internal` from reaching `privy-wallets.ts`, which `confidential-account.ts` imports.
6. **No production job compares the ledger with chain balances today.** Only a script does.
7. **Two quote combinations Phase 2 depends on were never quoted in the spike** (fund-in with `INTENTS` refund; fund-in return paid from `INTENTS`).

---

## A. How money comes in today

### A1. Fund-in

- **Quote.** `createFundIn`, `apps/api/src/services/intents/fund-in.ts:143-276`, called from `apps/api/src/routes/wallet.ts:212`. Fields at `:187-199`:
  - `EXACT_INPUT`, origin `ONE_CLICK_FUND_IN_USDC_ASSET_IDS[chain]`, destination NEAR USDC;
  - `recipient` = `refundTo` = `wallets.address`, `refundType: "INTENTS"`;
  - deadline now + 2 h (`:56`), slippage 100 bps (`:59`); deposit and recipient types default; no session.
  - Saved at `:228-253`, `quoteKey: fund-in:<uuid>`, audit `fund_in.created`.
- **Status.** `fundInsJob` (`apps/api/src/station/fund-ins.ts:12-19`, 30 s, lock 72_051) runs `refreshOpenFundIns` (`fund-in.ts:457-519`), then `refreshFundIn` (`:396-436`), then `refreshQuoteStatus` (`apps/api/src/services/intents/quote-status.ts:44-112`).
  - The only status call is `quote-status.ts:53`: `oneClick.status(quote.depositAddress)`.
  - `nextStatus` (`fund-in.ts:357-382`) maps SUCCESS, REFUNDED, FAILED, and PENDING past the deadline to `expired`. The update is guarded by `status IN (quoted, depositing, needs_review)` (`:426-428`).
  - `refreshFundIn` is also called by the deposit watcher (`near-deposits.ts:213`) and the public pay page (`pay-link.ts:433`).
- **Ledger.** Only the deposit watcher writes it: `nearDepositsJob` (`apps/api/src/station/near-deposits.ts:13-22`, 30 s, lock 72_050) runs `watchNearDeposits` (`apps/api/src/services/wallet/near-deposits.ts:779`).
  - `handleRow` (`:486-528`) confirms each indexer row against the RPC at FINAL.
  - `settleTransfer` (`:421-473`) uses `quotesListing` (`:143-166`), which matches the transfer's tx hash against `near_tx_hashes` / `destination_chain_tx_hashes`. `readQuote` (`:260-294`) returns `credit` for `fund_in`, `fund_in_return`, `invoice_payment`.
  - `creditDeposit` inserts at `:316-346`: `type: "deposit"`, `chain: "near"`, `usdcAmount: transfer.amount`, `txHash`, `receiptId`, `logIndex`, `transferIndex`, `blockNumber`, `counterpartyAddress`, then `.onConflictDoNothing()` (`:344`).
  - Idempotency key: `wallet_transactions_near_transfer_unique` on `(receipt_id, log_index, transfer_index) WHERE chain <> 'base'` (`apps/api/src/db/schema/wallet-transactions.ts:103-105`).

### A2. Invoice payment through the pay link

- **Quote.** `quoteForPayment`, `apps/api/src/services/invoices/pay-link.ts:249-380`; public, resolved from a public ID. The route file was not read.
  - Reuses an open quote for the chain with more than 30 min left (`:268-290`).
  - Otherwise quotes at `:292-304` with the fund-in's fields and `amount: centsToUsdc(invoice.totalCents)`. Saved at `:328-353` with `purpose: "invoice_payment"`, `invoiceId`.
- **Status.** The same fund-ins job (`OPEN_DEPOSIT_PURPOSES`, `fund-in.ts:288-291`), plus `getPayQuote` (`pay-link.ts:398-446`), which calls `refreshFundIn` when the last answer is older than 15 s.
- **Ledger and invoice.** The watcher's `creditDeposit` calls `recordLinkPayment` in the credit's transaction (`near-deposits.ts:349-359`).
  - `apps/api/src/services/invoices/link-payment.ts:45-149` calls `recordInvoicePayment` (`payment-record.ts:96-197`): locks the invoice, inserts `invoice_payments`, sets `paid`.
  - `notify invoice_paid` at `link-payment.ts:119-126`. The receipt is built at `:128-147` with `transactionUrl: nearTransactionUrl(input.txHash)` (`:145`) and emailed after commit (`near-deposits.ts:397-399`).
  - Constraints (`apps/api/src/db/schema/invoice-payments.ts:85-93`): `invoice_payments_intent_quote_id_unique`, `invoice_payments_wallet_transaction_id_unique`, and a `link` payment must name both a quote and a wallet transaction.

### A3. Fund-in return

- **Job.** `fundInReturnsJob` (`apps/api/src/station/fund-in-returns.ts:12-23`, 30 s, lock 72_052) runs `returnFundIns` (`apps/api/src/services/intents/fund-in-return.ts:389-446`).
  - It advances open returns found by `intent_quotes_to_refresh(ARRAY['fund_in_return'])` (`:412-428`).
  - Then, for every wallet from `active_main_chain_wallets()`, it calls `startFundInReturn` (`:183-366`).
- **Quote.** It reads `rpc.intentsBalances(address, FUND_IN_RETURN_ASSETS)` (`:217-220`) and takes `min(held, perTransactionMaxUsdc)` (`:234-235`). Fields at `:238-252`:
  - `EXACT_INPUT`, origin = the refunded token, `depositType: "INTENTS"`, destination NEAR USDC;
  - `recipient` = `refundTo` = wallet, `refundType: "INTENTS"`, deadline now + 10 min; no session.
  - Saved under `SELECT … FOR UPDATE` on the wallet row after re-checking nothing is in flight (`:277-287`), key `fund-in-return:<uuid>`.
- **Pay and settle.** `advanceFundInReturn` (`:86-130`) calls `continueCompanyDeposit(quote, sendFromIntents)` (`apps/api/src/services/intents/quote-deposit.ts:730-750`).
  - `deposit()` (`:527-602`) sends with key `quote:<id>` (`quote-settle.ts:25`); then `submitDeposit` (`:605-624`); then `settleFromOneClick` (`apps/api/src/services/intents/quote-settle.ts:88-143`).
- **Ledger.** The delivery reaches the company wallet from `intents.near` and the watcher credits it as in A1.

### A4. Plain USDC transfer to the company wallet

`settleTransfer`, `near-deposits.ts:421-473`:

- from the gas relayer: internal (`:428`);
- in a transaction one of the company's quotes lists: per `readQuote`;
- from `intents.near` and unexplained: held while 1Click could not be asked or any of the company's quotes is unsettled (`:459-470`, `firstUnsettledQuote` `:172-197`);
- otherwise `creditDeposit(wallet, transfer, null)` (`:471`), same insert and key as A1.

### A5. `wallet_transactions`

`apps/api/src/db/schema/wallet-transactions.ts`.

- **NOT NULL:** `id`, `organization_id`, `wallet_id`, `type`, `chain` (default `base`), `usdc_amount`, `created_at`.
- **Nullable:** `tx_hash`, `receipt_id`, `log_index`, `transfer_index`, `block_number`, `counterparty_address`, `payout_id`, `treasury_move_id`, `intent_quote_id`.
- **Append-only:** the app role has SELECT and INSERT; triggers reject UPDATE and DELETE (`apps/api/drizzle/0008_wallets_rls.sql:45-72`).
- **Unique:**
  - base transfers `(lower(tx_hash), log_index)` (`:100-102`);
  - NEAR transfers `(receipt_id, log_index, transfer_index)` (`:103-105`);
  - `intent_quote_id WHERE intent_quote_id IS NOT NULL AND usdc_amount < 0` (`:144-148`);
  - `payout_id WHERE type IN ('payout','withdrawal')` (`:154-156`).
- **Checks that block a credit with no chain transaction:**
  - `wallet_transactions_deposit_is_onchain` (`:157-160`): `type <> 'deposit' OR (tx_hash IS NOT NULL AND log_index IS NOT NULL AND block_number IS NOT NULL)`
  - `wallet_transactions_near_deposit_has_receipt` (`:168-171`): `chain = 'base' OR type <> 'deposit' OR receipt_id IS NOT NULL`
  - `wallet_transactions_quote_link_is_treasury` (`:135-138`): `intent_quote_id IS NULL OR type::text IN ('to_treasury','from_treasury')`
- **Checks that do not block it:** `amount_sign` (`:124-127`), `receipt_is_near` (`:163-166`), `near_hashes_are_base58` (`:178-181`).

---

## B. Design

Two rules hold throughout:

- **A quote's own columns decide its behaviour**, never the wallet's current `balance_home`. A quote opened before a company was switched still delivers to the public wallet and is credited by the watcher; the settlement credit applies only when `recipient_type = 'CONFIDENTIAL_INTENTS'`.
- **Every new parameter is optional and defaults to today's behaviour**, so other companies send the same request bytes as today (`oneClickQuoteBody`, `one-click.ts:415-435`).

### B0. Where the session comes from

`ConfidentialAccounts.session(company: NearSigningWallet)` (`apps/api/src/services/intents/confidential-account.ts:348-350`) needs `{ privyWalletId, accountId }`. Both are on the `wallets` row (`privyWalletId`, `address`).

Every status call funnels through `quote-status.ts:53`. That file is reached from `/internal` via `quote-settle.ts` and `staff/intent-quote-resolve.ts:31`, and `internal-routes.test.ts:224-228,290-293` forbids `/internal` from reaching `services/wallet/privy-wallets.ts`. So `quote-status.ts` cannot import `ConfidentialAccounts`. The session is passed in as an optional argument, resolved by callers that may sign.

New file `apps/api/src/services/intents/company-session.ts`:

```ts
export const touchesConfidentialAccount = (
  q: Pick<IntentQuote, "depositType" | "recipientType" | "refundType">,
): boolean =>
  q.recipientType === "CONFIDENTIAL_INTENTS" ||
  q.depositType === "CONFIDENTIAL_INTENTS" ||
  q.refundType === "CONFIDENTIAL_INTENTS";

/** undefined for a quote that touches no confidential account: no read, no sign-in. */
export function sessionForQuote(
  quote: Pick<
    IntentQuote,
    "organizationId" | "depositType" | "recipientType" | "refundType"
  >,
): Effect.Effect<
  OneClickSession | undefined,
  ConfidentialSessionError | DatabaseError,
  ConfidentialAccounts | DatabaseService
>;
```

It reads the company's `wallets` row in scope and calls `ConfidentialAccounts.session`. A missing or inactive wallet is a defect (`Effect.dieMessage`).

Optional `session?: OneClickSession` is added to:

- `refreshQuoteStatus(quote, session?)` (`quote-status.ts:44`);
- `settleFromOneClick(quote, session?)` (`quote-settle.ts:88`);
- `continueCompanyDeposit(input, send, session?)` and `advanceCompanyQuote({ quote, beforeDeposit, session? })` (`quote-deposit.ts:730, 652`);
- `OneClickShape.submitDeposit(depositAddress, txHash, session?)` (`one-click.ts:282-285`).

| 1Click call                                                                                                  | Session?                          | Source                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `quote` for move-in                                                                                          | yes (measured)                    | `startMoveIn` has the wallet row; `ConfidentialAccounts.session`                                                   |
| `quote` for fund-in / pay link / return of a confidential company                                            | yes (measured for fund-in)        | `ConfidentialAccounts.session` from the wallet row each already reads                                              |
| `status` of any quote where `touchesConfidentialAccount`                                                     | sent; whether required is unknown | `sessionForQuote(quote)` in `refreshFundIn`, `advanceMoveIn`, `advanceFundInReturn`, the watcher's `refreshQuotes` |
| `submitDeposit` for move-in / return                                                                         | not measured; send it             | same session as the advance                                                                                        |
| `balances`                                                                                                   | yes                               | inside `ConfidentialAccounts.usdcBalance`                                                                          |
| staff: `settleFromOneClick` (`intent-quote-resolve.ts:89`), `oneClick.status` (`staff/intent-quotes.ts:436`) | none available                    | see E1                                                                                                             |

### B5. Task 5: move-in job

**What must change in the shared functions.**

- `openCompanyQuote` (`quote-deposit.ts:135-287`) stays as it is. It hard-codes `EXACT_OUTPUT` (`:198`, `:261`), maps `destinationChain` to an asset (`:200`), has no recipient type, requires `amountIn - amountOut` within `maxQuoteCost` (`:233-241`) and carries a payout `link`.
  - The precedent for an exact-amount-in quote is a separate open function: `openTreasuryQuote` (`treasury-quote.ts:143-254`), `startFundInReturn`, `sweepTransitWallet` (`sweep.ts:269-385`).
- `advanceCompanyQuote` (`:652-722`) fits. The spike's move-in registered the deposit address with USDC and paid it with a plain `ft_transfer` (`apps/api/scripts/spike-confidential-intents.ts:813-830`), which are its steps 2 and 4. Two changes:
  1. `:699-702` skips the fee cover only for `to_treasury`. Change it to cover only what the fee-cover check allows: `(quote.purpose === "base_hop" || quote.purpose === "usdc_payout") && (yield* coverFee(quote)) === "waiting"`. A move-in gets no cover.
  2. Thread `session` to `continueCompanyDeposit`, then `submitDeposit` and `settleFromOneClick`.
- Export the recorded-surplus sum (the SQL at `quote-deposit.ts:313-338`) as `recordedExpendiSurplus(tx, walletId, excludeQuoteId?)`, and have `expendiSurplus` call it. The move-in amount and the reconcile both need it.
- `sendUsdcFromCompanyWallet` (`company-wallet-send.ts:904-912`) is used unchanged. It enforces the spend cap at signing (`:706-713`) and never sends twice under key `quote:<id>`.
- Schema: `intent_quotes_send_is_from_company_wallet` (`intent-quotes.ts:395-398`) must add `'move_in'`. Without it, `paid()` (`quote-deposit.ts:536-540`) fails after the USDC has left and the row never settles.

**New `apps/api/src/services/intents/move-in.ts`**, modelled on `fund-in-return.ts`:

```ts
export const MOVE_IN_MIN_USDC = 150_000n; // proposal, see E3
export const MOVE_IN_RETRY_AFTER_MS = 30 * 60_000; // as RETURN_RETRY_AFTER_MS
export type MoveInDeps =
  QuoteDepositDeps | NearRpc | ConfidentialAccounts | AuditLog;
export function startMoveIn(input: {
  organizationId: string;
}): Effect.Effect<IntentQuote | null, DatabaseError, MoveInDeps>;
export function advanceMoveIn(
  ref: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, MoveInDeps>;
export function moveIn(
  maxRows = 50,
): Effect.Effect<
  { advanced: number; started: number; errors: number },
  DatabaseError,
  MoveInDeps
>;
```

`startMoveIn`:

1. Read the wallet row. Require active, NEAR, implicit address, `privyWalletId`, and `balanceHome === "confidential_account"`.
2. Return null if any of these hold in the company's scope:
   - an unsettled `move_in`;
   - a `move_in` ended `refunded` or `failed` within 30 min;
   - an unsettled `base_hop`, `usdc_payout` or `to_treasury` quote (its funds or fee cover are waiting in the wallet);
   - a `company_wallet_sends` row `reserved` or `signed`;
   - a payout `funding`;
   - `isPaused` (`payout/guards.ts:25`), as sweeps and returns do.
3. `held = NearRpc.usdcBalance(address)`; `movable = held - recordedExpendiSurplus(tx, wallet.id)`. Below `MOVE_IN_MIN_USDC`, return null.
4. Amount in even parts under the cap, as Treasury does (`treasury/advance.ts:223-227`): `parts = ceil(movable / cap)`, `amount = ceil(movable / parts)`.
5. `session = ConfidentialAccounts.session({ privyWalletId, accountId: address })`, then `oneClick.quote(..., session)` with:
   - `swapType: "EXACT_INPUT"`, origin and destination both `ONE_CLICK_USDC_ASSET_IDS.near`, `amount`;
   - `depositType: "ORIGIN_CHAIN"`, `recipient: address`, `recipientType: "CONFIDENTIAL_INTENTS"`, `refundTo: address`, `refundType: "ORIGIN_CHAIN"`;
   - deadline `COMPANY_QUOTE_TTL_MS`, `slippageBps: 0` (as the spike).
6. Refuse the quote, logging and returning null, unless all hold:
   - firm, no memo, `isImplicitNearAccount(depositAddress)`, `depositAddress !== address`;
   - `amountIn === amount` and `amountOut === amountIn`.
   - Reason for the last: a move-in is not a ledger entry, so any charge would leave the confidential balance permanently below the ledger.
7. Under `SELECT … FOR UPDATE` on the wallet row, re-check step 2. Insert `purpose: "move_in"`, `quoteKey: move-in:<uuid>`, `recipientType: "CONFIDENTIAL_INTENTS"`; audit `move_in.created`. Then `advanceMoveIn`.

`advanceMoveIn`: `sessionForQuote(quote)`; if it fails, return the quote unchanged, because a deposit must not start when the quote can't be settled. Otherwise call `advanceCompanyQuote({ quote, session, beforeDeposit })`. The gate abandons when payouts are paused or `balance_home` is no longer `confidential_account`.

**Trigger.** New `apps/api/src/station/move-ins.ts`: `moveInsJob`, `everyMs: 30_000`, `lockKey: 72_055` (72_053 and 72_054 are taken), registered in `apps/api/src/server.ts:45-70`.

- `moveIn()` advances quotes from `intent_quotes_to_refresh(ARRAY['move_in'], n)`, then calls `startMoveIn` for each row of a new `confidential_account_wallets()` (section C).
- Other companies are never read. Cost is one `usdcBalance` RPC call per confidential company per tick. A balance of N caps moves in over about N ticks.

**Does Expendi's surplus matter?** Yes.

- The company wallet can hold relayer fee cover and leftovers from `EXACT_OUTPUT` buffer refunds (`quote-deposit.ts:296-307`), which are Expendi's.
- The job therefore moves `held - recordedSurplus`, not `held`. Surplus stays in the public wallet, and the reconcile difference means what it means today.
- A company that has never hopped has zero surplus. The staging demo company has hopped.
- USDC the watcher has not credited yet may be moved in. That is safe: the watcher credits from the transfer's receipt, wherever the USDC is now.

**Dust.** Below `MOVE_IN_MIN_USDC` nothing moves. It stays in the public wallet, counted by the ledger and the reconcile.

**Refunded or failed.**

| Outcome                                                    | State                                                                  | What happens                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadline within 3 min before the deposit, or gate abandons | `expired`                                                              | nothing moved; next tick quotes again                                                                                                                           |
| `SendRefused`                                              | `failed`                                                               | nothing moved; rests 30 min                                                                                                                                     |
| 1Click `REFUNDED`                                          | `refunded`                                                             | USDC returns to the wallet as an internal transfer (`readQuote` already returns internal for `move_in`, `near-deposits.ts:288-292`); rests 30 min, then retries |
| 1Click `FAILED`, or send outcome unknown past the deadline | `needs_review` (`quote-settle.ts:122-140`, `quote-deposit.ts:547-552`) | blocks further move-ins for that company until settled                                                                                                          |

None writes `wallet_transactions`.

**The staging script** (new `apps/api/scripts/confidential-account.ts`, modelled on `scripts/treasury-qa.ts`): commands `turn-on` and `turn-off`.

- It prints the banner (company name, database host), then requires all of:
  - `CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID` equals `--organization-id`. It is set only in the staging config; config has no environment name to test (`apps/api/src/config.ts`).
  - `--company-name` equals `organizations.name` exactly.
  - `--yes`.
  - Nothing in flight: no unsettled quote, no payout in a reserving or review status, no open Treasury move, no send in flight.
  - `ConfidentialAccounts.usdcBalance` succeeds, proving sign-in and the partner key.
- Then one transaction sets `wallets.balance_home` and audits `wallet.balance_home_changed`.
- It does not step the move. The job does, as `treasury-qa.ts:26-27` requires of its own moves. "The move-in job run over the whole balance" is therefore the flag flip.

### B6. Task 6: deliver to the confidential account, credit at settlement

**Quotes.** All three read the wallet row already; add `balanceHome` and `privyWalletId` to the select. When `balanceHome === "confidential_account"`, call `ConfidentialAccounts.session`, pass it as the second argument to `oneClick.quote`, set `recipientType: "CONFIDENTIAL_INTENTS"` on the request and the inserted row, and leave every other field alone.

- `createFundIn` (`fund-in.ts:187-199`, `:232-252`): refund stays `INTENTS` to the same account ID.
- `quoteForPayment` (`pay-link.ts:292-304`, `:332-352`): same. A public request now causes a sign-in at most once per session lifetime per process.
- `startFundInReturn` (`fund-in-return.ts:238-252`, `:290-310`): `depositType: "INTENTS"`, `recipientType: "CONFIDENTIAL_INTENTS"`, `refundType: "INTENTS"`.
- A session failure maps to the existing `quoteUnavailable` (the two routes) or to a logged null (the return).

**Status.**

- `refreshFundIn` resolves `sessionForQuote` itself and passes it to `refreshQuoteStatus`. Its input `Pick` gains `depositType`, `recipientType`, `refundType`; the select at `fund-in.ts:479-483` adds them.
- `advanceFundInReturn` does the same for `continueCompanyDeposit`.
- `fund-in.ts` is not reachable from `/internal` (I checked the value imports of `routes/internal/*` and `services/staff/*` by grep), so the import is safe there.

**Where the credit is written.** A confidential-delivery quote can reach `succeeded` by:

- `refreshFundIn` (`fund-in.ts:409-433`);
- `settleFromOneClick` (`quote-settle.ts:100-108`) for a return;
- staff's `askOneClick` (`intent-quote-resolve.ts:81-97`), which runs `settleFromOneClick` on any quote before any plan is checked.

So the credit is a separate step keyed by the quote. New `apps/api/src/services/intents/quote-credit.ts`:

```ts
export function creditSettledQuote(ref: {
  quoteId: string;
  organizationId: string;
}): Effect.Effect<
  "credited" | "already_credited" | "not_creditable" | "amount_unusable",
  DatabaseError,
  DatabaseService | AuditLog | EmailSender | ConfigService
>;
export function creditSettledQuotes(
  maxRows = 50,
): Effect.Effect<
  { credited: number; unusable: number; errors: number },
  DatabaseError,
  DatabaseService | AuditLog | EmailSender | ConfigService
>;
```

`creditSettledQuotes` reads `confidential_quotes_to_credit(max_rows)` (section C) and calls `creditSettledQuote` per row, each isolated. `fundInsJob` runs it straight after `refreshOpenFundIns`. A fund-in is credited in the tick that settles it; a return within 30 s.

`creditSettledQuote`, in one `withScope({ organizationId })` transaction:

1. `SELECT … FOR UPDATE` the quote. Return `not_creditable` unless `status = 'succeeded'`, `one_click_status = 'SUCCESS'`, `recipient_type = 'CONFIDENTIAL_INTENTS'` and purpose is `fund_in`, `invoice_payment` or `fund_in_return`. Return `already_credited` if `ledger_credited_at` is set.
2. `delivered = swappedAmountOut`, the amount 1Click reports delivered. If it is null, not positive, or above `depositedAmount ?? amountIn`, return `amount_unusable` and log an error.
   - Every credited route is 6-decimal USDC to USDC, so more out than in is impossible.
   - Treasury already refuses a delivery reported without an amount (`treasury/advance.ts:284-292`).
3. Insert the ledger row with `.onConflictDoNothing()`:

```ts
{ organizationId, walletId: quote.walletId, type: "deposit", chain: "near",
  usdcAmount: delivered, intentQuoteId: quote.id,
  txHash: null, receiptId: null, logIndex: null, transferIndex: null,
  blockNumber: null, counterpartyAddress: null }
```

4. If nothing was inserted, set `ledgerCreditedAt` and return `already_credited`.
5. Otherwise, for `invoice_payment`, call `recordLinkPayment(tx, { …, walletTransactionId, txHash: null, receivedUsdc: delivered, actor })`.
6. Audit `wallet.deposit_received` with `{ intentQuoteId, purpose, usdcAmount, source: "one_click_success", oneClickCheckedAt }`.
7. Set `intent_quotes.ledger_credited_at = now()`.
8. After commit, `sendInvoiceReceipt`.

**Exactly once:** the row lock, plus a new partial unique index on `wallet_transactions(intent_quote_id)` (section C). `ledger_credited_at` is only the work-queue marker.

**The ledger row with no chain transaction:** `type` stays `deposit`, so wallet history, the cash check, matchable deposits and exports keep working. It is identified by `intent_quote_id` with every chain column null.

**Paths that read a transaction hash.**

- `recordLinkPayment` input `txHash` becomes `string | null`; `transactionUrl` is `txHash === null ? null : nearTransactionUrl(txHash)` (`link-payment.ts:52,145`).
- `InvoiceReceiptEmailInput.transactionUrl` becomes `string | null`; the "Transaction:" line and the `<li>` are omitted when null (`apps/api/src/services/email/invoice-receipt-email.ts:18,44,51`). Phase 4 can put the payer's origin-chain transaction here.
- Already null-safe: `invoice-pdf.ts:54,433`; the invoice payments view (`invoices.ts:244-267`; shared `packages/shared/src/invoices.ts:300,331`); wallet history (`wallet/history.ts:58`; shared `wallet-history.ts:99`); `notify invoice_paid` carries no hash.
- Not read: how the web and mobile apps render a deposit whose `txHash` and counterparty are both null.
- The pay page needs no change: `succeeded` without a payment already shows `processing` (`pay-link.ts:193-195`), then `paid`.

**Deposit watcher** (`near-deposits.ts`):

1. `quotesListing` (`:143-166`) and `ListedQuote` (`:132-137`) also select `recipientType`.
2. `readQuote` (`:262-268`): for `fund_in`, `fund_in_return`, `invoice_payment` with `recipientType === "CONFIDENTIAL_INTENTS"`, return `{ kind: "internal" }` and log. Such a quote is credited at settlement only, so a transfer in a transaction it lists can never be a second credit.
3. `firstUnsettledQuote` (`:172-197`) adds a predicate so only a quote that could send USDC to the company wallet holds a transfer: `recipient_type = 'DESTINATION_CHAIN' OR (refund_type = 'ORIGIN_CHAIN' AND origin_asset = <NEAR USDC id>)`.
   - True for every row that exists today, so nothing changes for other companies.
   - False for a confidential fund-in, pay-link quote or return; true for a `move_in`, whose refund comes back.
4. `refreshQuotes` (`:204-226`) filters `quotesToRecheck` by the same predicate in TypeScript and passes `sessionForQuote(quote)` to `refreshQuoteStatus`. Without the filter, a failed sign-in would hold deposits behind quotes that can never show a transfer. `WatcherDeps` gains `ConfidentialAccounts`.
5. Optional hardening, `move_in` only: a transfer whose `from` is the deposit address of one of the company's `move_in` quotes is internal. See E2.

### B7. Task 7: reconcile and balance read

**Today.**

- The comparison exists only in the script: `reconcile`, `apps/api/scripts/lib/treasury-qa-commands.ts:600-729`. It reads the ledger, `NearRpc.usdcBalance(wallet.address)` and `baseUsdcBalance(transitAddress)`, with `differenceUsdc = near + base - ledger` (`:722-725`). In-flight reasons at `:706-717`. Printed by `formatReconciliation`, `treasury-qa-format.ts:125-141`.
- `expendiSurplus` (`quote-deposit.ts:418-425`) compares the same balances in production, but only to bound a fee cover.
- No job or alert compares ledger with chain. `reconciliationCheck` (`alerts/alert-checks.ts:152`) watches the provider reconcile jobs' heartbeat.
- Staff see the ledger balance only (`staff/companies.ts:202,257`; admin `company-view.tsx:98-103`).

**Design.**

1. New `apps/api/src/services/wallet/reconcile.ts`, holding the script's logic so the script and the alert share it:

```ts
export interface BalanceReconciliation {
  readonly balanceHome: WalletBalanceHome;
  readonly ledgerUsdc: bigint;
  readonly nearUsdc: bigint | null; // company wallet
  readonly baseUsdc: bigint | null; // transit wallet
  readonly confidentialUsdc: bigint | null; // null unless confidential, or unread
  readonly expendiSurplusUsdc: bigint; // recordedExpendiSurplus
  readonly differenceUsdc: bigint | null; // near + base + (confidential ?? 0) - ledger
  readonly inFlight: readonly string[];
  readonly errors: readonly string[];
}
export function reconcileBalances(
  organizationId: string,
): Effect.Effect<
  BalanceReconciliation | null,
  DatabaseError,
  DatabaseService | NearRpc | BaseRpc | ConfidentialAccounts
>;
```

`confidentialUsdc` is read with `ConfidentialAccounts.usdcBalance` only when `balanceHome === "confidential_account"`. The script's `reconcile` becomes a wrapper, and `formatReconciliation` gains a "Confidential account" line and the surplus.

2. "In flight" for the new quotes, added to the existing reasons:
   - a `move_in` that is `depositing` or `needs_review`: up to `amountIn` is between the wallet and the account;
   - a confidential-delivery quote that is `depositing` or `needs_review`: 1Click holds the payer's money and may already have delivered;
   - a confidential-delivery quote `succeeded` with `ledger_credited_at IS NULL`: delivered, credit due;
   - a `quoted` confidential fund-in or pay-link quote last checked more than 2 min ago.
   - Not in flight: a `quoted` one that 1Click reported `PENDING_DEPOSIT` within 2 min. The script today counts every `quoted` quote (`:641`); for an alert that would silence the check for the two hours a pay link stays open.

3. Alert: new kind `confidential_balance_mismatch`; `confidentialBalanceCheck()` in new `apps/api/src/services/alerts/confidential-alert-checks.ts`, modelled on `treasuryHoldingChecks` (`treasury-alert-checks.ts:246-383`), registered in `CHECKS` (`run-alerts.ts:39-54`); `CheckDeps` gains `NearRpc | ConfidentialAccounts`.
   - Per row of `confidential_account_wallets()`: keep the alert as it is when a read fails, something is in flight, or a quote settled or a ledger row was written in the last 5 min.
   - Fire when `differenceUsdc < 0`.
   - Fire when `differenceUsdc > expendiSurplusUsdc` and the excess is not sitting in the public wallet (`nearUsdc <= expendiSurplusUsdc + MOVE_IN_MIN_USDC`). That is USDC in the confidential account that no quote credited and no watcher ever will.
   - Details list the four figures. Thresholds are proposals.

4. Staff. `/internal` cannot sign in, so the alert check saves each reading it takes on the `wallets` row (`confidential_usdc`, `confidential_usdc_read_at`), and `companyDetail` (`staff/companies.ts:191-201,252-260`) returns `balanceHome`, `confidentialUsdc`, `confidentialUsdcReadAt` from the row.
   - Shared schema: `packages/shared/src/internal-ops.ts:136-150`.
   - Admin: a "Confidential account, as of …" figure in `company-view.tsx`, and the alert label in `apps/admin/src/app/(staff)/alerts/_components/columns.tsx:19-40`.

---

## C. Schema and migration

One generated migration (0102) plus one hand-written access migration (0103), as 0092 and 0093 did.

`apps/api/src/db/schema/intent-quotes.ts`:

```ts
/** When a delivery into a confidential account was written to the ledger. */
ledgerCreditedAt: timestamp("ledger_credited_at", { withTimezone: true }),

// replaces the check at :395-398
check("intent_quotes_send_is_from_company_wallet",
  sql`${table.companyWalletSendId} IS NULL OR ${table.purpose}::text IN ('base_hop', 'usdc_payout', 'fund_in_return', 'to_treasury', 'move_in')`),

// new: the rule about recipient_type the existing checks lack
check("intent_quotes_recipient_type_matches_purpose",
  sql`(${table.recipientType} = 'DESTINATION_CHAIN' OR ${table.purpose}::text IN ('move_in', 'fund_in', 'invoice_payment', 'fund_in_return')) AND (${table.purpose}::text <> 'move_in' OR ${table.recipientType} = 'CONFIDENTIAL_INTENTS')`),

check("intent_quotes_ledger_credit_is_confidential_delivery",
  sql`${table.ledgerCreditedAt} IS NULL OR (${table.status} = 'succeeded' AND ${table.recipientType} = 'CONFIDENTIAL_INTENTS' AND ${table.purpose}::text IN ('fund_in', 'invoice_payment', 'fund_in_return'))`),

index("intent_quotes_ledger_credit_due_idx").on(table.settledAt)
  .where(sql`${table.recipientType} = 'CONFIDENTIAL_INTENTS' AND ${table.status} = 'succeeded' AND ${table.ledgerCreditedAt} IS NULL`),
```

`intent_quotes_intents_side_matches_purpose` (`:405-408`) is unchanged. A move-in (ORIGIN_CHAIN both sides), a fund-in or pay-link quote (ORIGIN_CHAIN deposit, INTENTS refund) and a return (INTENTS both sides) all pass it as written. The plan's note that Phase 2 loosens it (`docs/work/confidential-accounts/plan.md:72`) applies only to Phase 3's refunds into a confidential account.

`apps/api/src/db/schema/wallet-transactions.ts`:

```ts
// replaces wallet_transactions_deposit_is_onchain (:157-160)
check("wallet_transactions_deposit_has_source",
  sql`${table.type} <> 'deposit' OR (${table.intentQuoteId} IS NULL AND ${table.txHash} IS NOT NULL AND ${table.logIndex} IS NOT NULL AND ${table.blockNumber} IS NOT NULL) OR (${table.intentQuoteId} IS NOT NULL AND ${table.chain} <> 'base' AND ${table.txHash} IS NULL AND ${table.receiptId} IS NULL AND ${table.logIndex} IS NULL AND ${table.transferIndex} IS NULL AND ${table.blockNumber} IS NULL)`),

// wallet_transactions_near_deposit_has_receipt (:168-171), one clause added
sql`${table.chain} = 'base' OR ${table.type} <> 'deposit' OR ${table.receiptId} IS NOT NULL OR ${table.intentQuoteId} IS NOT NULL`

// wallet_transactions_quote_link_is_treasury (:135-138), 'deposit' added to the list
sql`(${table.type}::text = 'to_treasury') <= (${table.intentQuoteId} IS NOT NULL) AND (${table.intentQuoteId} IS NULL OR ${table.type}::text IN ('to_treasury', 'from_treasury', 'deposit'))`

// new: one settlement credit per quote. The predicate names no enum, as :139-143 requires.
uniqueIndex("wallet_transactions_quote_settled_credit_unique").on(table.intentQuoteId)
  .where(sql`${table.intentQuoteId} IS NOT NULL AND ${table.txHash} IS NULL AND ${table.usdcAmount} > 0`),
```

The predicate leaves `from_treasury` credits (which carry a `tx_hash` and may come in several transfers) and `to_treasury` debits (negative) unbound. A watcher deposit never carries a quote link today (`near-deposits.ts:328-331`), so `intent_quote_id IS NULL` on the on-chain branch holds for existing rows; confirm on staging data before migrating.

`apps/api/src/db/schema/wallets.ts`:

```ts
confidentialUsdc: bigint("confidential_usdc", { mode: "bigint" }),
confidentialUsdcReadAt: timestamp("confidential_usdc_read_at", { withTimezone: true }),
check("wallets_confidential_reading_is_whole",
  sql`(${table.confidentialUsdc} IS NULL) = (${table.confidentialUsdcReadAt} IS NULL)`),
```

`packages/shared/src/internal-alerts.ts:9-23`: add `"confidential_balance_mismatch"` (generates `ALTER TYPE ops_alert_kind ADD VALUE`, as 0094 did).

Hand-written 0103, with the REVOKE/GRANT pattern of `0076_near_system_jobs.sql:57-59`:

```sql
CREATE FUNCTION confidential_account_wallets()
  RETURNS TABLE (wallet_id uuid, organization_id uuid, organization_name text, address text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT w.id, w.organization_id, o.name, w.address
    FROM wallets w JOIN organizations o ON o.id = w.organization_id
    WHERE w.status = 'active' AND w.chain <> 'base'
      AND w.balance_home = 'confidential_account'
    ORDER BY w.created_at $$;

CREATE FUNCTION confidential_quotes_to_credit(max_rows integer)
  RETURNS TABLE (quote_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT q.id, q.organization_id FROM intent_quotes q
    WHERE q.recipient_type = 'CONFIDENTIAL_INTENTS' AND q.status = 'succeeded'
      AND q.ledger_credited_at IS NULL
      AND q.purpose::text IN ('fund_in', 'invoice_payment', 'fund_in_return')
    ORDER BY q.settled_at LIMIT max_rows $$;
```

`intent_quotes_owner_reads` (0078) and `organizations_owner_reads` (0031) already let the definer read. The app role has table-level UPDATE on `wallets` and `intent_quotes` (`0008:5`, `0074:4`), so no new grants. `intent_quotes_to_refresh` takes purposes as an argument and serves `move_in` unchanged.

---

## D. Work packages

### First, by one person (shared files; nothing else starts before it)

- The schema edits and both migrations in C.
- `services/intents/company-session.ts` (B0).
- The optional `session` threading in `one-click.ts`, `quote-status.ts`, `quote-settle.ts`, `quote-deposit.ts`; the fee-cover condition at `quote-deposit.ts:699-702`; the `recordedExpendiSurplus` export.
- Test helpers:
  - `apps/api/src/__tests__/helpers/one-click.ts`:
    - fake `authenticate` (a session per `signer_id`) and `balances` (a per-account map under `nep141:<TEST_USDC_CONTRACT>`);
    - `quote` and `status` record the session and answer 401 when a confidential quote comes without one;
    - `state.deliverConfidential(depositAddress, amountOut)` sets SUCCESS and `amountOut` and raises the balance.
  - `helpers/db.ts:141`: `createActiveNearWallet` takes an optional `balanceHome`.
  - `helpers/money-in.ts:67-127`: `saveQuote` accepts `move_in` and a confidential variant; `ledgerOf` also selects `intentQuoteId`.
- Tests: extend `db/confidential-accounts.test.ts` and `db/treasury-ledger.test.ts` for each new or changed check and the new unique index. Keep `near-signing-boundary.test.ts` and `routes/internal-routes.test.ts` green unchanged.

**Contracts agreed up front:** the signatures in B0; `recordedExpendiSurplus(tx: Transaction, walletId: string, excludeQuoteId?: string): Effect.Effect<bigint, DatabaseError>`; the two SQL functions; columns `ledgerCreditedAt`, `confidentialUsdc`, `confidentialUsdcReadAt`; `MOVE_IN_MIN_USDC` exported from `move-in.ts` (WP3 imports it; until WP1 lands, WP3 uses a local constant of the same name); `creditSettledQuotes` and `reconcileBalances` as in B6 and B7.

### WP1: move-in

- **Owns:** `services/intents/move-in.ts`, `station/move-ins.ts`, `server.ts`, `scripts/confidential-account.ts`.
- **Adds:** `startMoveIn`, `advanceMoveIn`, `moveIn`, `moveInsJob`, the script.
- **Tests:** new `services/move-ins.serial.test.ts`, modelled on `fund-in-returns.serial.test.ts` (`makeNearUsdcFakes`, `createNearUsdcPayingCompany`, `makeFakeOneClick`). Cases:
  - a non-confidential company is never quoted;
  - request fields and session;
  - amount = held less recorded surplus, in even parts under the cap;
  - dust left alone; one at a time;
  - not started while a hop, payout or send is in flight, or paused;
  - quote refused unless `amountOut === amountIn`;
  - the send linked to the quote, and no ledger row written;
  - REFUNDED rests 30 min; FAILED goes to `needs_review` and blocks; nothing starts when sign-in fails.
  - A script test modelled on `scripts/treasury-qa.test.ts` for each guard.

### WP2: deliver and credit

- **Owns:** `services/intents/fund-in.ts`, `fund-in-return.ts`, `quote-credit.ts`, `services/invoices/pay-link.ts`, `link-payment.ts`, `services/email/invoice-receipt-email.ts`, `services/wallet/near-deposits.ts`, `station/fund-ins.ts`.
- **Changes:** as B6.
- **Tests:**
  - extend `fund-in-refresh.serial.test.ts` (the "never credits the ledger" case at `:177` stays for public companies) and `invoice-payments.serial.test.ts`;
  - new `services/quote-credit.serial.test.ts`: credited once across repeated and concurrent runs; amount is `swappedAmountOut`; null or out-of-bound amount not credited; a quote opened before the switch is not settlement-credited; a return credited; a quote settled through `settleFromOneClick` alone still credited; invoice paid and receipt sent without a transaction line;
  - extend `near-deposits.serial.test.ts`: a transfer listed by a confidential quote is internal; an `intents.near` transfer is not held behind an open confidential fund-in, and is held behind an unsettled `move_in`; a failed sign-in does not hold deposits;
  - `routes/pay.test.ts`, `routes/fund-ins.test.ts`: request fields for a confidential company, unchanged for others.

### WP3: reconcile and staff

- **Owns:** `services/wallet/reconcile.ts`, `services/alerts/confidential-alert-checks.ts`, `services/alerts/run-alerts.ts`, `scripts/lib/treasury-qa-commands.ts`, `scripts/lib/treasury-qa-format.ts`, `services/staff/companies.ts`, `packages/shared/src/internal-ops.ts`, the two admin files.
- **Tests:**
  - new `services/confidential-alerts.serial.test.ts`, modelled on `treasury-alerts.serial.test.ts`: each in-flight rule keeps the alert; negative difference fires; excess in the confidential account fires; excess in the public wallet does not; an unreadable balance keeps; the reading is saved;
  - extend `scripts/treasury-qa.test.ts` and `routes/internal-companies.test.ts`.

---

## E. Risks and open questions

### E1. Where the code contradicts or complicates the brief

1. **Staff cannot ask 1Click about a confidential quote or read the balance live** (B0).
   - If `status` requires the session, `askOneClick` and `intentQuoteEvidence` answer "1Click didn't answer" for these quotes.
   - Staff also cannot resolve one as "delivered": `planQuoteResolution` needs chain evidence of delivery (`staff/intent-quote-evidence.ts:547-552`) and there is none. "A fund-in isn't resolved here" (`:503-505`).
   - In Phase 2 a confidential quote in review is settled only by the job hearing SUCCESS or REFUNDED, or by hand in the database. Phase 4's runbook has to say so.
   - The alternative is to amend the guard so staff code may sign in. That is the founder's decision.
2. **A public request signs in** (`quoteForPayment`, `getPayQuote`). It is a sign-in, not a payment; it cannot be avoided if a pay link is to open a confidential quote.
3. **Sessions are per process.** The station runs in every API instance (`station/scheduler.ts:11-14`), and `session()` has no single-flight (`confidential-account.ts:445-452`). Whether a second sign-in invalidates the first token is unknown (E3).
4. **`ONECLICK_API_KEY` is optional** in config (`one-click.ts:781-793`) but required for every confidential call.
5. **The balance check cannot be per credit.** With no arrivals list and concurrent deliveries, a balance delta cannot be attributed to one quote. "Checked against the balance 1Click returns" is the periodic comparison in B7.
6. **Nothing stops a confidential company paying out.** The ledger shows the balance. A payout fails at the company wallet's send; a Base hop first has the relayer send fee cover into the wallet (`quote-deposit.ts:492-510`). A one-line refusal at payout approval until Phase 3 is the smallest guard. It is outside this design; on staging, do not approve payouts for the demo company.
7. **Each move-in costs Expendi** a USDC storage registration for the new deposit address (0.00125 NEAR, `near-main-chain.md` Base hop rule 2) plus relay gas.

### E2. Credited twice, never credited, or stuck

**Twice:**

- A refunded move-in whose refund transfer 1Click does not list. Once the quote is `refunded` nothing holds the transfer, and `settleTransfer` credits it as a deposit (`near-deposits.ts:471`). The exposure exists today for hop refunds and relies on 1Click listing the hash. A refund on the confidential route is unmeasured. Mitigations: B6 watcher item 5, and a forced-refund test before any real company.
- A quote opened before the switch: covered, because the credit is keyed on the quote's `recipient_type`.
- A transfer to the public wallet listed by a confidential quote: covered (internal).
- Two instances or a repeated run: covered by the row lock and the unique index.

**Never, or wrong amount:**

- SUCCESS without `amountOut`, or an amount above what was deposited: not credited, logged every run, and surfaced by the alert.
- USDC that reaches the confidential account with no quote of ours: there is no arrivals list, so only the alert shows it.
- 1Click revising `amountOut` after the credit: the ledger is append-only and the quote is credited once; the alert shows the gap.
- A move-in that delivers less than it took: no ledger entry can express it. The strict `amountOut === amountIn` check stops new ones; the alert shows an old one.

**Stuck:**

- A move-in 1Click will not quote (below its minimum, or priced): the USDC stays public, no row exists, and it retries every tick.
- A `move_in` in `needs_review` blocks all further move-ins for the company (E1.1).
- A refunded fund-in sits in the public NEAR Intents account if the return's combination is not quotable (E3).
- Payouts paused: move-ins stop, by design.
- Sign-in failing (Privy, RPC salt or 1Click down): confidential quotes stay unsettled and uncredited until it recovers. Nothing is expired wrongly, because `expired` needs 1Click's `PENDING_DEPOSIT`.

### E3. Unknown without NEAR Intents or a mainnet test

1. Does `GET /v0/status` answer for a session-made quote without the session, or with a newer session of the same account?
2. Does a new `authenticate` invalidate earlier access tokens?
3. Is a fund-in with `recipientType: CONFIDENTIAL_INTENTS` and `refundType: INTENTS` quotable? The spike's dry quote used `refundType: CONFIDENTIAL_INTENTS` (`spike-confidential-intents.ts:636-645`), which is not what was decided.
4. Is a return with `depositType: INTENTS` and `recipientType: CONFIDENTIAL_INTENTS` quotable? If not, the return can stay exactly as today: it delivers to the company wallet, the watcher credits it, and the move-in job moves it in, with no new code. That briefly shows the amount publicly and departs from decision 5; say which you want.
5. On SUCCESS for a confidential delivery, is `swapDetails.amountOut` always present and equal to the balance increase, and is the balance updated by then?
6. Where does a refunded move-in land, from which account, and is its transaction listed in `nearTxHashes`?
7. The move-in minimum, and whether it is always free. `MOVE_IN_MIN_USDC` is a guess from the 0.15 USDC fund-in minimum; dry-quote 0.01, 0.05 and 0.15.
8. Does `/v0/deposit/submit` need or accept the session?
9. Rate limits for the session-bearing calls: status per open quote every 30 s, balances per confidential company every 60 s.
10. Access to `/v0/account/history` (the plan's question 1), which would close the "arrived with no quote" gap.

## Decisions after the design

Taken 2026-11-13, after `scripts/spike-confidential-intents.ts --step probe` answered five of the open questions in E3 on mainnet (dry quotes and reads only, nothing moved).

**Measured**

- A fund-in from Base that delivers to the confidential account and refunds into the public NEAR Intents account (`refundType: INTENTS`) quotes: 0.999798 per 1 USDC, 35 s. E3.3 is answered yes.
- A fund-in return paid from the public NEAR Intents account (`depositType: INTENTS`) that delivers to the confidential account quotes: 0.999798 per 1 USDC, 10 s. E3.4 is answered yes, as a dry quote. The return goes straight to the confidential account, as decided.
- A move-in of 0.01, 0.05 and 0.15 USDC each quotes with nothing taken. E3.7: there is no minimum we could find and no fee.
- `GET /v0/status` for a confidential quote answers 404 "not found" with the partner key alone, and 200 with a session of the same account opened hours after the quote was made. E3.1: the session is required, and any session of that account will do.
- A second sign-in does not end the first: both tokens read the balance afterwards. E3.2 is answered no, so sessions per process without single-flight are safe.

**Decided**

1. `MOVE_IN_MIN_USDC` is `50_000n` (0.05 USDC). 1Click would move less, but every move-in costs Expendi a storage registration for its deposit address.
2. Staff code stays unable to sign in. `routes/internal-routes.test.ts` keeps forbidding `/internal` from reaching `privy-wallets.ts`, so for a confidential quote staff's "ask 1Click" answers that 1Click didn't answer, and staff see the balance the alert check last saved. A confidential quote in review is settled by the job or by hand. Phase 4's runbook says so.
3. Until Phase 3, a payout for a company whose `balance_home` is `confidential_account` is refused by the checks before paying, with a reason. It is built first, with the shared pieces, and Phase 3 removes it.
4. The deposit watcher's optional hardening (B6, watcher item 5) is built: a transfer from the deposit address of one of the company's `move_in` quotes is internal.
5. The alert's thresholds are as proposed in B7.
6. The check `intent_quotes_intents_side_matches_purpose` is not touched in Phase 2. The plan's note about loosening it applies to Phase 3.

**Changed while building**

7. The list of deliveries waiting to be credited (`confidential_quotes_to_credit`) is newest first, not oldest first. One that can't be credited stays in the list until a person settles it, and must not keep the ones behind it waiting.
8. A delivery that succeeded but isn't in the ledger counts as in flight for 10 minutes only (`CREDIT_DUE_MINUTES`). After that the alert fires and names the quote, whatever the balances say. Without the limit, a delivery whose reported amount can't be used would have kept the comparison quiet for good.
9. `reconcileBalances` reads the three balances first and the ledger, in-flight state and recent activity afterwards, in one snapshot. Read the other way round, a move-in that started in between looked like missing money.
10. `scripts/confidential-account.ts turn-off` refuses while the confidential account holds any USDC, because nothing can pay out of one until Phase 3.

**Before the migrations are released**

`0102_confidential_deliveries.sql` replaces three checks on `wallet_transactions`, which re-checks every existing row. No code path writes a deposit that carries a quote link today, but that was checked in the code, not in staging's or dev's data. Run a read-only count of `deposit` rows with `intent_quote_id IS NOT NULL` or with a null `tx_hash`, `log_index` or `block_number` on each database first.
