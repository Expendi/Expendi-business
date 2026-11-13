# Confidential accounts, Phase 3 (money out) and Phase 4 (what people see): design

**Status:** built 2026-11-13 as designed, with the changes in the last section. Tested against fakes only: nothing here has run on staging.

The coordinator's mainnet measurements of 2026-11-13 are folded in:

- The unused buffer of an exact-amount-out hop returns to the confidential account by itself about a minute after `SUCCESS`, and is not reported as a refund.
- Solana quotes.
- A transfer between two confidential accounts quotes free.
- Base into a confidential account with an `ORIGIN_CHAIN` refund quotes.
- A NEAR payout is free with `amountOut = amountIn`.

## Findings that change the brief

1. **The Base deposit watcher asks 1Click with no session.** `apps/api/src/services/wallet/deposits.ts:462` calls `refreshQuoteStatus(quote)` for hops and sweeps. For a confidential hop that answers 404, so a hop's arrival at the transit wallet waits (`HopArrivalUnconfirmed`) and, 15 minutes after the quote settles, is flagged as unexpected USDC (`:474-515`).
2. **The deposit watcher's hold predicate would hold deposits behind every confidential payout and hop.** `couldSendToCompanyWallet` (`apps/api/src/services/wallet/near-deposits.ts:184-197`) is true for any `recipient_type = 'DESTINATION_CHAIN'`.
3. **Staff can't hand a payout back after a confidential quote settles late.** `settleDelivery` only acts on `approved`, `funding` and `paying` (`apps/api/src/services/payout/delivery.ts:269-281`), and staff's hand-back needs a chain deposit (`apps/api/src/services/staff/intent-quote-evidence.ts:608-612`). There is none.
4. **Sweep costs are accounted nowhere.** `recordedExpendiSurplus` only reads `base_hop` and `usdc_payout` (`apps/api/src/services/intents/quote-deposit.ts:329`). A sweep into the confidential account at 0.999798 leaves holdings below the ledger, and the Phase 2 alert fires on any negative difference (`apps/api/src/services/alerts/confidential-alert-checks.ts:59`).
5. **`signIntent` signs a message for less than the quote's amount in** (`apps/api/src/services/intents/confidential-account.ts:296`). Both measured messages move exactly `amountIn`. Make it exact.
6. **The 0.15 USDC sweep minimum needs no code.** `SWEEP_DUST_USDC` is 1 USDC (`apps/api/src/services/intents/sweep.ts:44`, `:303`).
7. **`wallet_transactions` needs no change.** A debit, a `to_treasury` debit and a quote-linked `from_treasury` credit with no chain transaction pass every existing check.
8. **Exact-amount-out to NEAR out of a confidential account was never quoted.** What was measured twice is exact-amount-in, free. A NEAR payee should use that.
9. **Turning a company off has no path.** `turn-off` refuses while the account holds USDC (`apps/api/scripts/lib/confidential-account-commands.ts:203-210`), and Phase 3's tasks include no move back out.

Decisions for you are marked **Decide**.

---

## A. How money goes out today

Common to every kind:

- **Approval writes no ledger row.** `approvePayouts` (`apps/api/src/services/payout/approve.ts:361-550`) locks the wallet row (`:385-396`), checks `availableUsdc` (`:469`) and the caps (`:480`), and sets `approved` (`:483-502`).
- **Reservation, not debit, protects the balance.** `availableUsdc` is ledger less `reservedForPayouts` (payouts in `approved`, `order_created`, `funding`, `needs_review`, at `maxDebitUsdc`) less `reservedForTreasury` (`apps/api/src/services/wallet/ledger.ts:35-105`).
- **The spend cap is enforced in two places.** At signing: `company-wallet-send.ts:706-713`, inside `sign()`, the only place a company wallet signature is asked for. And when a quote is opened: `quote-deposit.ts:243-250` (`over_cap`). The transit and Treasury wallets keep Privy's policy cap.

### A1. USDC payout to a payee on NEAR (direct transfer)

1. `fundPayout` (`apps/api/src/services/payout/fund.ts:515-538`) calls `fundOnchainPayout` (`apps/api/src/services/payout/onchain.ts:535-628`).
2. Barrier under `lockPayout` (`:545-612`): pause, allowlist, then `funding` with `fundingStartedAt`, `depositAddress`, `amountToTransferUsdc = quotedUsdc` (`:587-598`). Another chain branches off at `:570-572`.
3. `driveNearPayout` (`:445-519`) runs under a per-payout advisory lock (`asOnlyDriver`, `:183-213`).
4. `attemptSend` (`:328-432`) re-checks pause and allowlist (`:344-354`), registers the payee with USDC (`prepareRecipient`, `:221-240`), then calls `sendUsdcFromCompanyWallet` with key `payout-<id>` (`:377-382`, `guards.ts:51`).

| Question          | Answer                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debit             | When the send has run on chain: `recordSent` (`:267-313`) sets `paying` and inserts `payout` or `withdrawal`, `chain: "near"`, `-amount`, `txHash`, `blockNumber`, `payoutId` |
| Idempotent by     | The `funding → paying` guard (`:275-281`) and `wallet_transactions_payout_debit_unique` (`apps/api/src/db/schema/wallet-transactions.ts:165-167`)                             |
| Paid              | `confirmOnchainPayouts` every minute (`:893-929`) proves the transfer from the saved send and the chain (`nearConfirmationFor`, `:692-736`)                                   |
| Refused           | `failed`, nothing sent (`:405-429`)                                                                                                                                           |
| Expired unrun     | Sent again, at most 3 sends (`:68`, `:504-513`)                                                                                                                               |
| Unclear           | Waits, then `needs_review` after 10 minutes (`:464-467`; `FUNDING_STUCK_MS`, `sync.ts:48`)                                                                                    |
| Refund, fee cover | None                                                                                                                                                                          |

### A2. USDC payout to a payee on Base or Solana

1. `deliverUsdcPayout` (`apps/api/src/services/payout/delivery.ts:327-376`) calls `openCompanyQuote` with key `delivery:<payoutId>`. The link to the payout is written in the insert's transaction (`quote-deposit.ts:252-283`).
2. The request (`quote-deposit.ts:196-207`): `EXACT_OUTPUT`, `amount = quotedUsdc`, refund to the company wallet, deadline 10 minutes (`:63`), slippage 10 bps (`:77`). Checks at `:222-250`.
3. `continueDelivery` (`delivery.ts:311-318`) runs `advanceCompanyQuote` (`quote-deposit.ts:680-757`):
   - expire if under 3 minutes remain (`:701-705`);
   - the relayer registers the deposit address (`:707-723`);
   - `coverFee` (`:730-735`);
   - the gate `takeFundingBarrier` (`delivery.ts:63-122`) sets the payout `funding`;
   - the quote goes `depositing` with `depositStartedAt` (`:741-748`);
   - `continueCompanyDeposit` (`:766-790`).
4. `deposit()` (`:551-626`) sends under key `quote:<id>` (`quote-settle.ts:25`) and saves `companyWalletSendId` and `depositTxHash` (`:560-564`). Inside the last 3 minutes it only reads an earlier send (`:581-605`). An unknown outcome is `needs_review` 5 minutes past the deadline (`:571-576`, `:90`).
5. `submitDeposit` (`:629-649`), then `settleFromOneClick` (`apps/api/src/services/intents/quote-settle.ts:90-146`):
   - `SUCCESS` gives `succeeded` and `REFUNDED` gives `refunded`, from `depositing` or `needs_review`;
   - `FAILED`, or unsettled 30 minutes past the deadline, gives `needs_review` (`:125-143`, `:22`).

| Question                | Answer                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debit                   | When the deposit has run: `settleDelivery` sees `depositTxHash` (`delivery.ts:270-271`) and `recordDeposited` (`:128-191`) sets `paying` and debits exactly the approved USDC |
| Paid                    | Quote `succeeded`; `providerReference = destinationChainTxHashes[0]` (`:284-299`)                                                                                             |
| Refund                  | `recordRefunded` (`:199-254`): `failed` plus a `refund` row of the debited amount, with no transaction hash (`:226-236`)                                                      |
| Failed or expired quote | `failPayout`, nothing sent (`:272-273`)                                                                                                                                       |
| `needs_review`          | `reviewPayout` (`:274-278`, `:302-303`)                                                                                                                                       |
| Job                     | `outboundQuotesJob`, 15 s (`apps/api/src/station/outbound-quotes.ts:15-24`), with a catch-up pass (`apps/api/src/services/payout/outbound-quotes.ts:164-198`)                 |

**Fee cover** (`coverFee`, `quote-deposit.ts:469-548`):

- The amount is `(amountIn − amountOut) − expendiSurplus` (`:501-506`).
- It is saved on the row before the relayer sends (`:507-513`), and the hash is saved before broadcast (`:516-534`).
- A second transfer is built only when the chain shows the first failed (`:485-499`).

**Surplus:**

- `recordedExpendiSurplus` (`:303-336`) sums `fee_cover_usdc` less each quote's cost by status. Succeeded costs `swappedAmountIn − amountOut`; refunded costs `amountIn − refundedAmount`; in flight costs the whole difference.
- `expendiSurplus` (`:351-459`) uses it only when nothing else of the company is in flight and the chain shows that much above the ledger.

### A3. Cash-out, and a payroll run

1. `fundCashOutThroughHop` (`fund.ts:484-508`) calls `planBaseHops` (`apps/api/src/services/payout/base-hop.ts:107-194`).
2. Payouts are grouped by `approvalId` (`:149-153`), so a payroll run approved in one approval gets one quote for the sum of `maxDebitUsdc` (`:162-168`). It splits only above `hopBudget(cap)` (`:46-52`, `:156-159`). Key `base-hop:<first id>`; recipient the transit wallet.
3. `advanceBaseHop` (`:212-239`): the gate needs payouts not paused and a cash-out still waiting.
4. `settleHopPayouts` (`:256-304`):
   - `succeeded` funds each payout;
   - `refunded`, `expired` or `failed` fails them;
   - `needs_review` sends them to review.
5. `fundPaycrestPayout` (`fund.ts:91-449`):
   - requires the hop `succeeded` (`:194-201`);
   - claims `orderRequestedAt` (`:221-236`);
   - checks the transit balance (`:320-330`);
   - takes the funding barrier (`:333-365`);
   - sends from the transit wallet with Privy key `payout-<id>` (`:383-390`).

| Question                 | Answer                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Debit                    | When the transit wallet's send returns (`:421-431`), on Base. Never at the hop (`base-hop.ts:31-33`) |
| A hop's refund or buffer | Arrives at the company wallet and is internal (`near-deposits.ts:365-369`)                           |
| A provider refund        | Credited at the transit wallet as `refund` (`deposits.ts:323-341`, read in part)                     |
| Pretium                  | `pretium-fund.ts`: same hop precondition (`:287-288`). Read in part                                  |

### A4. Sweep

- `sweepTransitWalletsJob`, every 5 minutes (`station/outbound-quotes.ts:30-40`).
- `sweepTransitWallet` (`sweep.ts:269-387`):
  - nothing in flight (`:57-105`);
  - balance above 1 USDC (`:303`), capped at the per-transaction maximum (`:306-309`);
  - `EXACT_INPUT` Base to NEAR, recipient the company wallet, refund to the transit wallet (`:312-323`);
  - saved under the wallet row lock (`:349-383`).
- `advanceSweep` (`:130-260`):
  - Privy send with key `sweep-<id>` (`:198-205`);
  - refused is `failed`; unknown is `needs_review`, never re-sent (`:206-224`);
  - `submitDeposit` and `settleFromOneClick` carry no session (`:246-258`).
- Not a ledger entry. Its arrival is internal.

### A5. Move to Treasury

1. `checkMove` (`apps/api/src/services/treasury/moves.ts:232-292`) requires `availableUsdc ≥ amount`. The move reserves what it hasn't debited (`ledger.ts:61-84`).
2. `nextPart` (`apps/api/src/services/treasury/advance.ts:213-264`) opens `openTreasuryQuote` (`treasury-quote.ts:143-254`): `EXACT_INPUT`, so the company pays the charge and there is no fee cover (`quote-deposit.ts:726-735`).
3. `advanceCompanyQuote` runs with gate `gateOnOpenMove` (`advance.ts:148-195`).

| Question       | Answer                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debit          | `recordDebit` (`:100-139`) once the send has run: `to_treasury`, `-amountIn`, linked to move and quote. Unique by `wallet_transactions_to_treasury_quote_unique` (`wallet-transactions.ts:155-159`) |
| Succeeded      | Vault deposit of `swappedAmountOut` (`:266-355`)                                                                                                                                                    |
| Refunded       | Waits for the deposit watcher's `from_treasury` credit (`:363-385`; `near-deposits.ts:346-363`, `:393-420`)                                                                                         |
| `needs_review` | The move goes to review (`:426-431`)                                                                                                                                                                |

### A6. Move to wallet

1. `stepToWallet` (`to-wallet.ts:207-242`) withdraws from the vault, then `stepReturn` (`return-engine.ts:149-205`).
2. `openTreasuryReturnQuote` (`treasury-quote.ts:305-419`): Base to NEAR `EXACT_INPUT`, recipient the company wallet, refund to the Treasury wallet.
3. `advanceTreasuryReturnQuote` (`treasury-return.ts:99-205`): Privy send with key `treasury-return-<quoteId>` (`:143-150`), then `submitDeposit` and `settleFromOneClick` with no session (`:191-203`).
4. **Credit:** the deposit watcher, from the transfer, as `from_treasury` linked to the move and the quote (`near-deposits.ts:393-420`). The move completes when `creditedByQuote ≥ swappedAmountOut` (`return-engine.ts:51-52`, `:183-188`), or goes to review after 30 minutes uncredited (`:198-203`).

### A7. How a send is saved before it is relayed

`apps/api/src/services/wallet/company-wallet-send.ts`:

- `reserve` (`:556-656`) saves the nonce and expiry before anything is signed. Unique per live key and one in flight per wallet (`company-wallet-sends.ts:125-136`).
- `sign` (`:664-731`) checks the cap, signs, and saves the signed bytes (`:724-729`).
- `relayAndSettle` (`:737-792`) saves each relayer hash before broadcast (`:749-779`).
- `settle` (`:452-510`): executed or failed from the chain; `expired` only when a final block past the expiry shows the nonce unused (`:490-502`); otherwise `SendOutcomeUnknown`.
- The same key re-relays the same bytes. A new send is built only after `expired` (`:851-856`).

Phase 3 mirrors this for an intent.

---

## B. Design for a company whose `balance_home` is `confidential_account`

Rules throughout:

1. A quote's own columns decide how it behaves (`deposit_type`, `recipient_type`, `refund_type`). `balance_home` is read only where a new quote is opened.
2. Every new request field is absent for other companies, so `oneClickQuoteBody` (`one-click.ts:417-437`) sends the same bytes.
3. **A confidential quote's ledger entries are written when 1Click reports its outcome, not when the message is accepted.** This matches decision 2 for credits. See B3.

### B0. Sessions

`advanceCompanyQuote` resolves the session itself when none is passed and the quote touches a confidential account, using `sessionForQuote` (`company-session.ts:36-77`). If sign-in fails it returns the quote unchanged, as `advanceMoveIn` does (`move-in.ts:418-425`).

- `quote-deposit.ts` is not reachable from `/internal`: staff code value-imports only `quote-settle.js` and `one-click.js` from `intents/`.
- `QuoteDepositDeps` gains `ConfidentialAccounts`.
- The session always comes from the wallet row: `{ privyWalletId, accountId: address }`.

| 1Click call                                                   | Session?                     | Where it comes from                                                                                                      |
| ------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `quote` for a confidential hop, payout or Treasury part       | yes (measured)               | `ConfidentialAccounts.session` in `openCompanyQuote` / `openTreasuryQuote`                                               |
| `quote` for a sweep or Move to wallet into the account        | yes (measured dry)           | same, in `sweepTransitWallet` / `openTreasuryReturnQuote`                                                                |
| `quote` for a fee-cover delivery                              | yes, the receiving company's | `startFeeCover`                                                                                                          |
| `generateIntent`, `submitIntent`                              | yes (called with it)         | the session `advanceCompanyQuote` resolved                                                                               |
| `status` of any quote touching a confidential account         | yes (404 without)            | the same session; `sessionForQuote` in `advanceSweep`, `advanceTreasuryReturnQuote`, `advanceFeeCover` and `deposits.ts` |
| `submitDeposit` for a sweep, Move to wallet part or fee cover | sent; not known to be needed | same                                                                                                                     |
| `balances`                                                    | yes                          | inside `ConfidentialAccounts.usdcBalance`                                                                                |
| staff calls                                                   | none                         | B8                                                                                                                       |

### B1. Task 8: the deposit step

**Where it lives.** A sibling file, `apps/api/src/services/intents/quote-intent.ts`, exporting `advanceIntentQuote`. `advanceCompanyQuote` branches to it on `quote.depositType === "CONFIDENTIAL_INTENTS"` before anything else.

Why a sibling and not a branch inside `deposit()`:

- The chain path has three steps the intent path doesn't: registering the deposit address, the relayer's cover to the company wallet, and `submitDeposit`.
- `deposit()` is built around a send key and a chain outcome.
- A sibling leaves every line of the chain path untouched.

The four callers (`base-hop.ts:215`, `delivery.ts:314`, `treasury/advance.ts:199`, `move-in.ts:426`) don't change.

**What replaces `company_wallet_sends`.** The quote row itself: `signed_intent`, `intent_deadline`, `intent_submitted_at`, `intent_hash`. One quote has one message, so no second table is needed.

- `company_wallet_send_id`, `deposit_tx_hash`, `deposit_registration_tx_hash` and `fee_cover_usdc` stay null (checked, section C).
- The per-wallet "one send in flight" rule has no equivalent. It existed for the nonce. The balance check below replaces what it gave.

**State machine**, against the existing statuses:

| State                     | Columns                                                 | What a run does                               |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| S0 `quoted`               | `depositStartedAt` null                                 | Checks below, then to S1                      |
| S1 `depositing`, unsigned | `signedIntent` null                                     | generate, check, sign, save; to S2            |
| S2 `depositing`, signed   | `signedIntent`, `intentDeadline` set; `intentHash` null | submit the saved bytes; to S3                 |
| S3 `depositing`, accepted | `intentHash` set                                        | `settleFromOneClick`                          |
| `needs_review`            | `depositStartedAt` set                                  | `settleFromOneClick`; the deadline rule below |
| final                     |                                                         | `succeeded`, `refunded`, `failed`, `expired`  |

**S0 to S1**, in order:

1. Under 3 minutes to `quote.deadline`: `expired`, nothing moved.
2. **Fee cover**, for `base_hop` and `usdc_payout` only: `ensureFeeCover(quote)` (B2). `waiting` returns the quote unchanged.
3. **Balance.** Read `usdcBalance(company)`. It must be at least `quote.amountIn` plus the `amountIn` of the wallet's other intent-paid quotes that are `depositing` or `needs_review`. Otherwise return unchanged; it expires at step 1 if it never clears.
   - Why: approval reads the ledger, which also counts USDC still in the public wallet waiting for a move-in, and the buffer of the last hop is out for about a minute after `SUCCESS` (measured).
4. `beforeDeposit` gate, as today. `abandon` gives `expired`.
5. In one transaction: lock the wallet row, re-sum step 3's in-flight amounts against the balance just read, then `quoted → depositing` with `depositStartedAt`.

**S1 to S2**, under a per-quote advisory lock (the pattern of `asOnlyDriver`, `onchain.ts:183-213`, with a new lock class), so a request and the job never both sign:

1. Within 3 minutes of the deadline with nothing signed: `failed`, "No message was signed before the quote's deadline. Nothing moved."
2. `OneClick.generateIntent({ depositAddress, signerId }, session)`. Any failure returns unchanged and is retried.
3. Read the wallet row now: active, `address === quote.refundTo`, and `perTransactionMaxUsdc`.
4. `ConfidentialAccounts.signIntent({ company, unsigned, depositAddress, amountIn, spendCap })`.
   - `CompanyIntentRefused` or `SendRefused`: `failed`, nothing was signed. Log at error level with the reason.
   - `PrivyWalletError`: unchanged. No signature exists outside Privy (`confidential-account.ts:364-371`), so the next run may generate again.
5. **Save:** `moveQuote(quote, status = depositing AND signed_intent IS NULL, { signedIntent: signed, intentDeadline: deadline })`. If the update matches nothing, drop the signature and re-read.

**S2 to S3:**

1. If `intentSubmittedAt` is null, set it first. It marks "handed to 1Click, or about to be", as `callStartedAt` does for an Earn call (`treasury/move-state.ts:391-405`).
2. `OneClick.submitIntent(quote.signedIntent, session)`: the saved object, never a re-signed one.
   - 200: save `intentHash`.
   - Any failure: unchanged. The next run submits the same bytes.
3. No new submit inside the last 3 minutes before `quote.deadline`. Only status is read from then on.

**Settle:** `settleFromOneClick(quote, session)`, unchanged:

- `SUCCESS` gives `succeeded` and `REFUNDED` gives `refunded`, from `depositing` or `needs_review`.
- `FAILED`, or unsettled 30 minutes after `quote.deadline`, gives `needs_review`.

**The one new settlement rule.** After `settleFromOneClick`, if all of these hold, the quote is `failed`: "The signed message expired unused. Nothing moved."

- the quote is `depositing` or `needs_review`;
- `signedIntent` is set;
- now is past `intentDeadline` plus 5 minutes;
- 1Click answered in this run with `PENDING_DEPOSIT` and no `depositedAmount`.

**How the decision record's Signing rules map:**

| Rule                                                  | Where it holds                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save before submitting                                | S1 step 5 precedes S2                                                                                                                                                                 |
| A retry submits the same saved bytes                  | S2 reads `signed_intent` from the row                                                                                                                                                 |
| A new message only after success, refund or deadline  | A retry of a payout is a new payout and a new quote. The old quote reaches `failed` only with no signed message or past `intent_deadline`. A database check enforces this (section C) |
| Unsettled after its 1Click deadline is `needs_review` | `settleFromOneClick`'s existing rule on `quote.deadline`                                                                                                                              |

**Two deadlines.** `intent_quotes.deadline` is the usable one: the lesser of 1Click's and the 10 minutes we asked for (`one-click.ts:162-166`, `:495-498`). `intent_deadline` is the message's own, three days. `MAX_INTENT_LIFETIME_MS` already bounds it at 4 days (`confidential-account.ts:63`). No extra margin constant is added: `DEPOSIT_MARGIN_MS` is reused.

**Every failure point:**

| Where it stops                       | What is left                         | Recovery                                                          | Signed twice? Paid twice?                                                                         |
| ------------------------------------ | ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Before S1                            | `quoted`                             | next run, or `expired`                                            | no                                                                                                |
| generate fails                       | S1                                   | retried, then `failed` at the margin                              | nothing signed                                                                                    |
| message fails the check              | `failed`                             | payout fails, retryable                                           | nothing signed                                                                                    |
| Privy unclear                        | S1                                   | generates again                                                   | the first signature never left Privy                                                              |
| crash after signing, before the save | S1                                   | generates and signs again                                         | a second signature exists, but the first lived only in the dead process and nothing can submit it |
| two drivers at once                  | advisory lock, then the guarded save | one signs                                                         | no                                                                                                |
| crash after the save                 | S2                                   | next run submits the saved bytes                                  | no                                                                                                |
| submit times out or errors           | S2                                   | resubmits the same bytes                                          | the nonce runs once (assumed, F3)                                                                 |
| submit refused                       | S2 with `failure` text               | resubmits until the margin, then 1Click's status decides          | no                                                                                                |
| 1Click silent after submit           | S3                                   | status polled; `needs_review` at deadline + 30 minutes            | no                                                                                                |
| late `SUCCESS` or `REFUNDED`         | `needs_review`                       | `settleFromOneClick` settles it; staff hand the payouts back (B8) | no                                                                                                |
| never executed                       | `needs_review`                       | `failed` after `intent_deadline`                                  | the message is dead                                                                               |
| sign-in fails                        | unchanged                            | nothing starts or is submitted                                    | no                                                                                                |

**Decide (1).** A quote signed and saved but never accepted (`intent_hash` null) at its deadline waits up to three days in review under the literal rule. It needs the job to be down for 7 minutes straight, since every 15 s run resubmits. I recommend keeping the literal rule. Relaxing it is one branch.

**Changes to Phase 1 code:**

- `checkCompanyIntent` refuses `amount !== amountIn` (`confidential-account.ts:296-298`), with a new reason `amount_not_the_quote`.
- Add `submitIntent`, `signIntent` and `generateIntent` to `MONEY_MOVING_CALL` in `apps/api/src/__tests__/routes/internal-routes.test.ts`, so staff code can never submit a saved message.

### B2. Fee cover

|                              | (i) relayer-paid delivery per hop                                                                                                                                                            | (ii) float, topped up in advance                                      | (iii) charge the company                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Added wait per hop or payout | about 20 s every time                                                                                                                                                                        | none in the usual case                                                | none                                                                                                                                                                                                                                         |
| Cost                         | one storage registration (0.00125 NEAR) and relay gas per hop                                                                                                                                | the same per top-up                                                   | none to Expendi                                                                                                                                                                                                                              |
| Code                         | A second quote lifecycle per hop: `coverFee`'s model is a plain transfer that is final on chain (`quote-deposit.ts:469-548`); a 1Click delivery can be refunded after its transfer succeeded | The same quote type, plus a threshold and a job. (i) is its slow path | Breaks "debited for exactly the approved USDC" (`delivery.ts:124-127`); a shared payroll hop's cost can't be split per payout (`base-hop.ts:149-181`); no ledger type for a fee (`wallet-transactions.ts:124-127`); reverses Base hop rule 3 |

**Recommendation: (ii), with a strict gate.** Your lean holds against the code.

**The delivery.** New purpose `fee_cover`, in a new `apps/api/src/services/intents/fee-cover.ts`, modelled on `move-in.ts`:

- **Quote:** `EXACT_INPUT`, USDC on NEAR to USDC on NEAR, `depositType: ORIGIN_CHAIN`, recipient the company's account with `recipientType: CONFIDENTIAL_INTENTS`, `refundTo: relayer.accountId`, `refundType: ORIGIN_CHAIN`, slippage 0. Refused unless `amountOut === amountIn`. This is the spike's `move-in` step exactly (`apps/api/scripts/spike-confidential-intents.ts:902-913`).
- **Pay:** `relayer.registerUsdcAccount`, then `relayer.sendUsdc`, with the hash saved in `deposit_tx_hash` before broadcast and resent only if the chain shows it failed (the rule of `coverFee`, `quote-deposit.ts:485-499`).
- **Settle:** `settleFromOneClick` with the company's session. A refund goes to the relayer, so the deposit watcher never sees it.
- One unsettled `fee_cover` per company, saved under the wallet row lock.
- New job `feeCoversJob`, 30 s, lock key `72_056` (the next free one after `station/move-ins.ts:15`).

**The gate**, `ensureFeeCover(quote)`:

- `needed = amountIn − amountOut`.
- `float = recordedExpendiSurplus(tx, walletId, quote.id, "confidential_account")`.
- `float ≥ needed` is `covered`. Otherwise it starts a `fee_cover` of `max(needed − float, FEE_FLOAT_TARGET_USDC − float)` and answers `waiting`.
- The job also tops up any confidential company whose float is under `FEE_FLOAT_LOW_USDC`.
- Proposed constants: target 1 USDC, low 0.25 USDC.

**What the float costs to run.** Measured cost to Base is 4,800 units plus about 2 bps. A NEAR payout is free. The 10 bps buffer comes back within about a minute, so the float settles near the buffer of the company's largest hop, as surplus does in a public wallet today. `CONFIDENTIAL_SLIPPAGE_BPS` (default `STABLECOIN_SLIPPAGE_BPS`) is the one constant that sizes it.

**What it does to each thing you named:**

- **`recordedExpendiSurplus`** gains a pool argument: `(tx, walletId, excludeQuoteId?, pool = "company_wallet")`.
  - `company_wallet`: today's sum plus `AND deposit_type <> 'CONFIDENTIAL_INTENTS'`, which is true for every existing row.
  - `confidential_account`: delivered `fee_cover` quotes (`coalesce(swapped_amount_out, amount_out)`), less today's cost CASE over hop and payout quotes with `deposit_type = 'CONFIDENTIAL_INTENTS'`, less the cost of succeeded sweeps into the account.
  - In-flight and `needs_review` quotes already count their whole difference (`:319`), so concurrent hops can't spend the float twice.
  - The measured buffer return fits unchanged: cost is `swappedAmountIn − amountOut`, and `refundedAmount` is 0.
  - Move the function to `apps/api/src/services/intents/expendi-surplus.ts`, re-exported from `quote-deposit.ts`. `quote-intent.ts` and `fee-cover.ts` need it without importing `quote-deposit.ts` in a cycle.
- **`expendiSurplus`** (`:351-459`) is unchanged and used only on the chain path. The intent path needs no chain proof: the gate uses the recorded float and the balance check proves the USDC is there.
- **Reconcile:** `expendiSurplusUsdc` becomes both pools. A new field `companyWalletSurplusUsdc` is the public pool.
- **Move-in "movable":** unchanged, `held − recordedExpendiSurplus(company_wallet pool)` (`move-in.ts:187-196`). Expendi's surplus from before the switch stays in the public wallet. The staging demo company has some.
- **Alert:** the "waiting to be moved in" test (`confidential-alert-checks.ts:62-63`) uses `companyWalletSurplusUsdc`. The thresholds are otherwise unchanged. Company money spent on Expendi's costs shows as "short".

**Decide (2).** Expendi absorbs sweep costs into the float, as its surplus does in practice today. The alternative is a tolerance in the alert.

**Later option.** The confidential-to-confidential transfer now quotes free, so Expendi could hold one confidential account and pay cover by signed intent, with no storage registration and no public relayer transaction. It is dry-quoted only and needs the relayer to sign in and sign intents. `startFeeCover` is the single function to change.

### B3. When the ledger is written

Under rule 3:

| Quote outcome         | USDC payout (`funding`)                                   | Cash-out hop                                    | Move to Treasury part                                                              |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `succeeded`           | one transaction: debit `-amountToTransferUsdc` and `paid` | payouts funded from the transit wallet as today | debit `-amountIn`, then the vault deposit                                          |
| `refunded`            | `failed`, no ledger rows                                  | payouts `failed`                                | debit `-amountIn` and credit `+refundedAmount` in one transaction; move `returned` |
| `failed` or `expired` | `failed`, nothing sent                                    | `failed`                                        | as today (`advance.ts:432-438`)                                                    |
| `needs_review`        | `needs_review`, still reserving                           | `needs_review`                                  | move `needs_review`                                                                |

Why not debit at acceptance, as the chain path debits when the send has run: a 200 from `submit-intent` is not proof the transfer executed. A payout debited on it and never executed would be "debited without being paid" until a person acted. With the outcome rule that state can't exist, and the payout's reservation covers the 13 to 30 s gap.

The alternative is one predicate: `quote.depositTxHash !== null || quote.intentHash !== null` at `delivery.ts:270` and `advance.ts:106`.

### B4. Task 9: USDC payouts

**`fundOnchainPayout`** (`onchain.ts:570-578`): read `{ privyWalletId, balanceHome }` before the chain branch, and route to the quote when `recipient.chain !== "near" || balanceHome === "confidential_account"`. A payout already `funding` as a direct send keeps its send.

**`deliverUsdcPayout`** (`delivery.ts:333-341`): drop the NEAR refusal. For a NEAR payee, run `prepareRecipient` first; a named account that isn't registered fails the payout with today's messages (`onchain.ts:236-238`). Move `prepareRecipient` to a new `apps/api/src/services/payout/near-recipient.ts` so both call sites share it.

**`openCompanyQuote`** (`quote-deposit.ts:136-288`):

```ts
readonly destinationChain: PayeeChain; // was "base" | "solana"
```

- It already reads the whole wallet row (`:172-180`).
- When `wallet.balanceHome === "confidential_account"`: take the session (a failure is `QuoteNotOpened { reason: "one_click_unavailable" }`), add `depositType` and `refundType` `"CONFIDENTIAL_INTENTS"`, pass the session, and write both columns on insert. `refundTo` stays `wallet.address`.
- Otherwise the request object is literally today's, and `destinationChain: "near"` is refused.
- **NEAR payee:** `swapType: "EXACT_INPUT"`, `amount = quotedUsdc`, slippage 0, refused unless `amountOut === amountIn === amount`. Cost 0, no buffer, no cover needed.
- **Base and Solana:** `EXACT_OUTPUT` as today.
- The existing checks hold: the confidential deposit address is 64-hex (fixture `apps/api/src/__tests__/fixtures/one-click/confidential-intents.json`), and `amountIn ≤ perTransactionMaxUsdc`.

**`settleDelivery`** (`delivery.ts:260-308`) adds one branch for intent-paid quotes while the payout is `funding`:

- `succeeded`: new `recordDelivered(payout, quote)`. One transaction under `lockPayout`: `funding → paid`, `paidAt`, `providerReference = destinationChainTxHashes[0] ?? null`. `payouts.tx_hash` stays null. The debit is `payout` or `withdrawal`, `chain: "near"`, `-amount`, `txHash: null`, `blockNumber: null`, `payoutId`. Idempotent by the status guard and `wallet_transactions_payout_debit_unique`.
- `refunded`: `failPayout`, "NEAR Intents refunded the payment: the USDC is back in the company's account. Nothing was sent."
- `expired`, `failed`, `needs_review`: the existing lines.

**Receipt:** `providerReference` is the payee chain's transaction. For a NEAR payee it is 1Click's public transfer from the shared account.

**Job:** nothing new. `followOnchainPayout` already skips a payout with a `deliveryQuoteId` (`onchain.ts:835-841`), and the catch-up pass covers `funding` (`outbound-quotes.ts:173-198`).

### B5. Task 10: Base hop and sweep

**Hop.**

- `planBaseHops` is unchanged: `openCompanyQuote` branches on the wallet. `advanceBaseHop` is unchanged too.
- Buffer and refund return to the confidential account (measured for the buffer). A confidential quote never lists a transfer to the company wallet, and `readQuote` treats hops as internal anyway.
- `settleHopPayouts` needs only its refund wording changed (`base-hop.ts:278-282`).
- **`deposits.ts:462`** becomes `sessionForQuote(quote).pipe(Effect.flatMap((session) => refreshQuoteStatus(quote, session)))`. Its deps gain `ConfidentialAccounts`. The file is reached from `routes/alchemy-webhooks.ts:13`, not from `/internal`.

**Sweep.**

- `sweepTransitWallet` (`sweep.ts:311-323`, `:359-379`): for a confidential wallet take the session, add `recipientType: "CONFIDENTIAL_INTENTS"` (recipient stays `wallet.address`), and insert the column. The refund stays the transit wallet on Base (measured dry: 0.999798, 35 s).
- `advanceSweep` resolves `sessionForQuote(quote)` first. No session means the quote is returned unchanged and no deposit starts. It passes the session to `submitDeposit` (`:248-250`) and `settleFromOneClick` (`:258`).
- Not a ledger entry: `creditSettledQuote` never credits a sweep, and the check in section C forbids it.
- Dust is unchanged at 1 USDC. `sweep.ts` is not reachable from `/internal`.

### B6. Task 11: Treasury

**Move to Treasury.**

- `openTreasuryQuote` and `estimateTreasuryPart` (`treasury-quote.ts:101-254`) take the same confidential branch as `openCompanyQuote`: session, `depositType` and `refundType` `CONFIDENTIAL_INTENTS`, columns on insert.
- `advanceCompanyQuote` takes the intent path. There is no fee cover: the company pays, as today.
- In `treasury/advance.ts`:
  - `recordDebit` (`:100-139`) also runs for an intent-paid quote that is `succeeded` or `refunded`, with `txHash: null`.
  - For `refunded`, the same transaction also inserts `from_treasury`, `+refundedAmount`, linked to the move and the same quote. A refund with no reported amount sends the move to review, as an unreported delivery does (`:284-292`).
  - The "ledger comes first" test (`:410-413`) becomes "has a send, or is intent-paid and settled".
  - `endWhenRefundCredited` then finds the credit and ends the move `returned`.

**Move to wallet.**

- `openTreasuryReturnQuote` and `estimateTreasuryReturnPart` add `recipientType: "CONFIDENTIAL_INTENTS"` and the session.
- `advanceTreasuryReturnQuote` passes the session at `treasury-return.ts:194` and `:203`, and doesn't start without one.
- **Credit: `quote-credit.ts` fits.** Changes:
  - the purpose test (`:92-98`) adds `from_treasury`;
  - for it, the row is `type: "from_treasury"`, `treasuryMoveId: quote.treasuryMoveId`, audit `wallet.treasury_returned`;
  - the amount rule (`:105-112`) is unchanged.
  - `stepReturn` already waits for exactly this row (`return-engine.ts:183-188`).
- **Database rules:** `intent_quotes_ledger_credit_is_confidential_delivery`, `intent_quotes_recipient_type_matches_purpose` and the function `confidential_quotes_to_credit` each add `from_treasury`. `wallet_transactions_quote_settled_credit_unique` already makes the credit once per quote.
- The credit lands with the `fundInsJob` run, within 30 s.

### B7. What Phase 3 changes in Phase 2

1. **Payout guard: remove.** `approve.ts:265-266`, `:400-407`, and `balanceHome` from the select at `:387`. Remove the reason from `payout-errors.ts:21` and its case in `apps/api/src/http/payout-rejection.ts:29`.
2. **Move-in "may start"** (`move-in.ts:135-143`): the hop, payout and Treasury clause adds `deposit_type = 'ORIGIN_CHAIN'`. A confidential quote keeps nothing in the public wallet, and one in review for three days would otherwise stop move-ins while payouts need that money. The send and `funding` clauses stay.
3. **Move-in "movable":** unchanged. Money at rest is already in the account, and no confidential payout draws on the public wallet. The balance check in B1 is what keeps a payout from needing USDC that hasn't been moved in yet.
4. **Reconcile in flight** (`reconcile.ts:108-135`): select `depositType`. An intent-paid quote that is `depositing` or `needs_review` is in flight. `CREDITED_DELIVERY_PURPOSES` (`:56-60`) adds `from_treasury`. A `fee_cover` falls into the existing confidential-recipient switch correctly.
5. **Alert:** as in B2.
6. **Deposit watcher** (`near-deposits.ts`):
   - `couldSendToCompanyWallet` and its SQL twin (`:184-197`) become `(recipient_type = 'DESTINATION_CHAIN' AND deposit_type <> 'CONFIDENTIAL_INTENTS') OR (refund_type = 'ORIGIN_CHAIN' AND origin_asset = <NEAR USDC> AND purpose <> 'fee_cover')`. True for every existing row.
   - `readQuote` (`:331-371`): a `from_treasury` quote with a confidential recipient, and a `to_treasury` quote with a confidential refund, are internal. `ListedQuote` adds `refundType`. `fee_cover` is internal.
7. **Script:** `turn-off`'s refusal text changes. **Decide (3):** how the balance comes back out. A `move_out` quote, the mirror of move-in, is free and was measured to the relayer in the spike. It is not in tasks 8 to 11.
8. **Fake 1Click:** `generateIntent` and `submitIntent` (`apps/api/src/__tests__/helpers/one-click.ts:336-337`) are faked. See section E.

### B8. Staff

**What staff can't do.** Staff code can't sign in, so it can't:

- ask 1Click about a confidential quote (`staff/intent-quotes.ts:436-438` and `intent-quote-resolve.ts:81-97` answer "1Click didn't answer");
- read the account's balance live or its history;
- resolve a quote 1Click hasn't settled. There is no chain deposit or refund to show.

**What staff can already see.** The detail view returns the last status the job heard, with times, hashes and amounts (`staff/intent-quotes.ts:309-334`).

**Smallest safe change**, with no sign-in and nothing signed:

1. Move `touchesConfidentialAccount` to `quote-status.ts`, re-exported from `company-session.ts`, so staff code may import it.
2. `intentQuoteEvidence`: for such a quote, skip the live call and build the view from the row.
3. `gatherQuoteEvidence` (`intent-quote-evidence.ts:257-261`): for `deposit_type = 'CONFIDENTIAL_INTENTS'` return no deposits and no refunds, and read deliveries from the chain as today.
4. `planQuoteResolution`, for an intent-paid quote:
   - while `needs_review`: refuse, saying it settles when the job hears `SUCCESS` or `REFUNDED`, or fails after `intentDeadline`;
   - once the job has settled it and payouts are still held: allow the matching outcome only, with no deposit evidence required, and hand the payouts back (`funding` for a USDC payout, `approved` for a cash-out). The delivery code then debits and pays, or fails, by its own rules.
5. `prepareQuoteResolution` and `confirmQuoteResolution` skip `askOneClick` for these quotes and require `oneClickCheckedAt` within the last 5 minutes.
6. The detail view and the shared schema add `depositType`, `recipientType`, `refundType`, `intentHash`, `intentDeadline`, `intentSubmittedAt`. **Never `signedIntent`**: it is spendable until its deadline.

A confidential quote that 1Click reports `FAILED` stays in review for NEAR Intents support and a correction by hand.

---

## C. Schema and migrations

One generated migration (0104) and one hand-written (0105), as 0102 and 0103.

`apps/api/src/db/schema/intent-quotes.ts`:

```ts
// INTENT_QUOTE_PURPOSES: add "fee_cover" (and in the shared package's list of purposes).

// replaces intent_quotes_intents_side_matches_purpose (:427-430)
check("intent_quotes_intents_side_matches_purpose",
  sql`(${table.depositType} = 'INTENTS') = (${table.purpose}::text = 'fund_in_return')
    AND (${table.depositType} <> 'CONFIDENTIAL_INTENTS' OR ${table.purpose}::text IN ('base_hop', 'usdc_payout', 'to_treasury'))
    AND (${table.refundType} <> 'INTENTS' OR ${table.purpose}::text IN ('fund_in', 'fund_in_return', 'invoice_payment'))
    AND (${table.refundType} = 'CONFIDENTIAL_INTENTS') = (${table.depositType} = 'CONFIDENTIAL_INTENTS')`),

// replaces intent_quotes_recipient_type_matches_purpose (:404-407)
check("intent_quotes_recipient_type_matches_purpose",
  sql`(${table.recipientType} = 'DESTINATION_CHAIN' OR ${table.purpose}::text IN ('move_in', 'fund_in', 'invoice_payment', 'fund_in_return', 'sweep', 'from_treasury', 'fee_cover'))
    AND (${table.purpose}::text NOT IN ('move_in', 'fee_cover') OR ${table.recipientType} = 'CONFIDENTIAL_INTENTS')`),

// replaces intent_quotes_ledger_credit_is_confidential_delivery (:411-414): add 'from_treasury'
// to the purposes. A sweep, move-in and fee cover can never be credited.

// new: only a quote paid out of a confidential account carries a signed message
check("intent_quotes_signed_intent_is_confidential",
  sql`${table.signedIntent} IS NULL OR (${table.depositType} = 'CONFIDENTIAL_INTENTS' AND ${table.depositStartedAt} IS NOT NULL)`),

// new: such a quote is never paid by a transfer on chain
check("intent_quotes_confidential_deposit_has_no_send",
  sql`${table.depositType} <> 'CONFIDENTIAL_INTENTS' OR (${table.companyWalletSendId} IS NULL AND ${table.depositTxHash} IS NULL AND ${table.depositRegistrationTxHash} IS NULL AND ${table.feeCoverUsdc} IS NULL)`),

// new: Signing rule 4 in the database. A signed quote fails only after its message's deadline.
check("intent_quotes_signed_fails_after_its_deadline",
  sql`${table.status} <> 'failed' OR ${table.signedIntent} IS NULL OR ${table.settledAt} > ${table.intentDeadline}`),

// replaces intent_quotes_expired_never_deposited (:454-457): add AND signed_intent IS NULL
```

The first replacement gives the same answer as the old check for every row that exists: none has a `CONFIDENTIAL_INTENTS` deposit or refund. It allows both to be confidential together for `base_hop`, `usdc_payout` and `to_treasury` only, so a fund-in still can't refund into a confidential account (decision 5).

Unchanged: `intent_quotes_send_is_from_company_wallet` and `intent_quotes_fee_cover_is_for_a_company_send`. A `fee_cover` quote keeps the relayer's hash in `deposit_tx_hash`.

`apps/api/src/db/schema/wallet-transactions.ts`: no rule changes, only the comment at `:80-85`. A refunded confidential `to_treasury` quote's credit names its quote. Verified against each check:

| Row                                                          | Passes                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| payout or withdrawal debit, `tx_hash` null, `chain = 'near'` | `amount_sign`, `payout_has_payout`, `receipt_is_near`, `near_hashes_are_base58` (nulls allowed). The deposit checks apply to `deposit` only |
| `to_treasury` debit, `tx_hash` null                          | `treasury_has_move`, `quote_link_is_treasury`, `to_treasury_quote_unique`                                                                   |
| `from_treasury` credit, `tx_hash` null, quote-linked         | the same, plus once per quote by `wallet_transactions_quote_settled_credit_unique` (`:145-149`)                                             |

Hand-written 0105: `CREATE OR REPLACE FUNCTION confidential_quotes_to_credit` with `'from_treasury'` added. `intent_quotes_to_refresh` takes purposes as an argument and serves `fee_cover` as it is.

Not read: the staff queue function `staff_intent_quote_queue`. Check whether it filters by purpose.

Before release, count rows that would fail each replaced check on staging and dev, as Phase 2's note asks.

---

## D. Phase 4

### D1. Where a hash or link shows, and what a confidential leg shows

| Place                                                                                                                                                                                                            | Today                                               | Confidential leg                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invoice PDF (`apps/api/src/services/invoices/invoice-pdf.ts:433-437`)                                                                                                                                            | "NEAR transaction" with a link, from the ledger row | Already omitted (null). Optional: the payer's own transaction from `origin_chain_tx_hashes[0]`, unlinked                                                                                                                                                    |
| Invoice receipt email (`apps/api/src/services/email/invoice-receipt-email.ts:48-61`)                                                                                                                             | link to NEAR                                        | Already omitted (Phase 2)                                                                                                                                                                                                                                   |
| Bill payment receipt PDF (`apps/api/src/services/bills/payment-receipt.ts:161`, `:358-369`)                                                                                                                      | `ledger.txHash ?? payout.txHash`, linked if NEAR    | USDC payout: both null, so show `payout.providerReference` labelled with the payee chain, linked only when that chain is NEAR. Cash-out: unchanged, the Base funding transaction                                                                            |
| Cash-out receipt (`apps/api/src/services/payout/receipts.ts:38-52`)                                                                                                                                              | M-Pesa or bank code only                            | No change                                                                                                                                                                                                                                                   |
| Wallet history API (`apps/api/src/services/wallet/history.ts:151`), web (`apps/web/src/app/(company)/wallet/_components/tx-sheet.tsx:194-198`), mobile (`apps/mobile/src/features/wallet/history-display.ts:63`) | the row's `txHash` as "<row chain> transaction"     | The row hash is null, so nothing shows. Add `payout.deliveryTxHash` (= `providerReference` for a paid `onchain` payout with a delivery quote), labelled with `recipientChain`. Mobile's handling of a null counterparty was read only at `:63-64`; check it |
| Withdrawal (`apps/api/src/services/withdrawal/withdrawals.ts:76`; web `withdraw-sheet.tsx:345-347`; mobile `withdraw.tsx:330-337`)                                                                               | `payout.txHash`                                     | `payout.txHash ?? providerReference`                                                                                                                                                                                                                        |
| CSV export (`apps/api/src/services/export/data.ts:119-121`)                                                                                                                                                      | `coalesce(p.tx_hash, '')`                           | `coalesce(p.tx_hash, p.provider_reference, '')`: same output for every existing row                                                                                                                                                                         |
| Treasury export (`apps/api/src/services/export/treasury.ts:158`, `:185-188`)                                                                                                                                     | ledger, Earn and deposit hashes                     | NEAR hashes are null already. Optional: add the Base delivery hash for a confidential `to_treasury` part                                                                                                                                                    |
| Admin quote page (`apps/admin/src/app/(staff)/intent-quotes/[id]/_components/intent-quote-view.tsx:138`, `:147`)                                                                                                 | deposit transaction, 1Click's NEAR transactions     | Show "Paid by signed message", its hash, deadline, when submitted and when 1Click was last heard. No sends section. Label 1Click's NEAR transactions as the shared account's                                                                                |
| Admin Treasury view (`treasury-view.tsx:67-69`)                                                                                                                                                                  | links for deposit and NEAR hashes                   | No change; null hashes are skipped                                                                                                                                                                                                                          |
| Admin payout page (`payout-view.tsx`, `columns.tsx`)                                                                                                                                                             | not read                                            | Check for a null `txHash` on a paid USDC payout                                                                                                                                                                                                             |
| Zoho posting (`apps/api/src/services/zoho/posting.ts:403-405`)                                                                                                                                                   | cash-out receipt only, never a hash                 | No change                                                                                                                                                                                                                                                   |
| Web activity (`activity-display.ts:623-627`)                                                                                                                                                                     | `txHash` from the audit entry                       | The new audit entries carry no NEAR hash                                                                                                                                                                                                                    |

### D2. Runbook outline (`docs/work/confidential-accounts/runbook.md`)

1. **What it is, and what staff can and can't see.** The saved balance reading; no history; no live 1Click.
2. **Turning a company on.** Prerequisites: `ONECLICK_API_KEY`, the demo organisation variable, nothing in flight. The command. What happens next: move-ins, the first fee-cover top-up. How to confirm: the company page's figure, the reconcile command.
3. **Turning a company off.** The guard, and how the balance is emptied first (per Decide 3).
4. **A quote in review.** How it gets there, what the page shows, and the three ways out:
   - the job hears `SUCCESS` or `REFUNDED`;
   - the message's deadline passes;
   - NEAR Intents support, for `FAILED`.

   Then handing held payouts back. Never retry the payout while its quote is open.

5. **The alert `confidential_balance_mismatch`.** "Short", "unexplained" and "delivered but not credited": what to check first, and which in-flight states keep it quiet.
6. **Fee cover.** The float, the relayer's USDC balance, a top-up that was refunded.
7. **When 1Click or sign-in is down.** What stops and what resumes by itself.
8. **Never:** copy `signed_intent` anywhere, set `balance_home` by SQL, or re-send.

### D3. Live QA on staging (the shape of `docs/work/treasury/qa-plan.md`)

1. **Before you start:** owner to-dos (deploy, migrations 0102 to 0105, relayer USDC, demo variable); the QA driver (`scripts/confidential-account.ts`, plus `reconcile` in `scripts/treasury-qa.ts`).
2. **Automated checks:** the gate. Section E's tests green; `near-signing-boundary` and `internal-routes` green.
3. **Live checks**, each recording quote ID, seconds, balances before and after, and the reconcile difference:
   - C1 turn on; the whole balance moves in; first top-up.
   - C2 fund-in from Base; C3 invoice payment through the pay link (Phase 2 repeats).
   - C4 USDC payout to NEAR, to a registered and to a new implicit account.
   - C5 to Base. C6 to Solana.
   - C7 withdrawal.
   - C8 cash-out through each cash-out provider.
   - C9 payroll run: one hop for the total.
   - C10 sweep of a provider refund into the account; the float after it.
   - C11 Move to Treasury. C12 Move to wallet.
   - C13 two payouts at once against a tight balance.
   - C14 a payout approved while its USDC is still in the public wallet.
   - C15 a forced refund, if one can be made (a quote left to pass its deadline before submit).
   - C16 kill the API between save and submit, and watch the resubmit.
   - C17 public trace: none of the NEAR transactions names the company.
   - C18 receipts, exports and staff pages against D1.
   - C19 a public company's payout, compared field by field with a run before the deploy.
4. **Not forced live:** a three-day expiry, 1Click `FAILED`.
5. **Hygiene and results table.**

---

## E. Work packages

### First, by one person (WP0: task 8 and the shared pieces)

**Owns:**

- `db/schema/intent-quotes.ts`, both migrations;
- `intents/quote-intent.ts` (new), `intents/expendi-surplus.ts` (new), `intents/quote-deposit.ts`, `intents/confidential-account.ts`, `intents/quote-status.ts` and `company-session.ts` (the predicate move);
- test helpers `one-click.ts`, `near-usdc-payouts.ts`, `near-payouts.ts`, `money-in.ts`, `db.ts`;
- `routes/internal-routes.test.ts`.

**Adds:**

```ts
// quote-intent.ts
export function advanceIntentQuote<R>(input: {
  readonly quote: IntentQuote;
  readonly session: OneClickSession;
  readonly beforeDeposit: (
    quote: IntentQuote,
  ) => Effect.Effect<DepositGate, DatabaseError, R>;
  readonly ensureFeeCover: (
    quote: IntentQuote,
  ) => Effect.Effect<"covered" | "waiting", DatabaseError, IntentQuoteDeps>;
}): Effect.Effect<IntentQuote, DatabaseError, IntentQuoteDeps | R>;
export const isIntentPaid = (q: Pick<IntentQuote, "depositType">): boolean =>
  q.depositType === "CONFIDENTIAL_INTENTS";

// expendi-surplus.ts
export type SurplusPool = "company_wallet" | "confidential_account";
export function recordedExpendiSurplus(
  tx: Transaction,
  walletId: string,
  excludeQuoteId?: string,
  pool: SurplusPool = "company_wallet",
): Effect.Effect<bigint, DatabaseError>;
```

Also: the `openCompanyQuote` change (B4), the branch and session resolution in `advanceCompanyQuote`, and the exact-amount check in `checkCompanyIntent`.

**Fake 1Click:**

- `generateIntent` returns a message `checkCompanyIntent` accepts for the faked quote: real token ID from `TEST_USDC_CONTRACT`, a versioned nonce, a three-day deadline.
- `submitIntent` records the bytes in `state.submittedIntents` and returns a hash. Submitting lowers the confidential balance by `amountIn`.
- `state.failNextGenerate()`, `state.failNextSubmit("refused" | "unknown")`, `state.badNextIntent(reason)`.
- `status` already needs the signer's session; extend it to quotes paid from the account.

**Tests:**

- new `services/quote-intent.serial.test.ts`, modelled on `outbound-quotes.serial.test.ts` and `company-wallet-send.test.ts`, with one case per row of B1's failure table. Among them: bytes submitted twice are identical; nothing is submitted without a prior save; the cap refuses; the balance check holds a second quote; `failed` only after the intent deadline;
- extend `db/confidential-accounts.test.ts` and `db/intent-quotes.test.ts` for every check in C;
- extend `confidential-account.test.ts` (exact amount) and `fake-one-click.test.ts`;
- `near-signing-boundary.test.ts` passes unchanged.

### WP1: Expendi's money and the checks

**Owns:** `intents/fee-cover.ts` (new), `station/fee-covers.ts` (new), `server.ts`, `wallet/reconcile.ts`, `alerts/confidential-alert-checks.ts`, `intents/move-in.ts`, `wallet/near-deposits.ts`, `scripts/lib/confidential-account-commands.ts`, `scripts/lib/treasury-qa-*.ts`.

```ts
export function ensureFeeCover(
  quote: IntentQuote,
): Effect.Effect<"covered" | "waiting", DatabaseError, FeeCoverDeps>;
export function startFeeCover(input: {
  organizationId: string;
  atLeast: bigint;
}): Effect.Effect<IntentQuote | null, DatabaseError, FeeCoverDeps>;
export function advanceFeeCover(
  ref: Pick<IntentQuote, "id" | "organizationId">,
): Effect.Effect<IntentQuote, DatabaseError, FeeCoverDeps>;
export function coverFees(
  maxRows?: number,
): Effect.Effect<
  { advanced: number; started: number; errors: number },
  DatabaseError,
  FeeCoverDeps
>;
```

**Tests:**

- new `services/fee-covers.serial.test.ts`, modelled on `move-ins.serial.test.ts`;
- extend `move-ins.serial.test.ts` (not blocked by a confidential hop in review), `confidential-alerts.serial.test.ts` (float, sweep cost, intent in flight), `near-deposits.serial.test.ts` (not held behind a confidential payout; internal for the two Treasury cases), `scripts/treasury-qa.test.ts`.

### WP2: USDC payouts and staff

**Owns:** `payout/onchain.ts`, `payout/delivery.ts`, `payout/near-recipient.ts` (new), `payout/approve.ts`, `payout/payout-errors.ts`, `http/payout-rejection.ts`, `staff/intent-quotes.ts`, `staff/intent-quote-evidence.ts`, `staff/intent-quote-resolve.ts`, `packages/shared/src/internal-intent-quotes.ts`, the admin quote page.

**Tests:**

- extend `usdc-delivery.test.ts`, `near-usdc-payouts.serial.test.ts` and `onchain-payouts.test.ts`: a NEAR payee through a quote; debit and `paid` together; refund leaves no ledger rows; an unregistered named payee fails;
- extend `payout-engine.test.ts` (guard gone);
- extend `routes/internal-intent-quotes.serial.test.ts` (hand-back; refusal while in review; no live call);
- `routes/withdrawals.test.ts`.

Helpers: `createNearUsdcPayingCompany`, `createDeliveryCompany`, `makeFakeOneClick`.

### WP3: Base hop and sweep

**Owns:** `payout/base-hop.ts` (wording), `intents/sweep.ts`, `wallet/deposits.ts`.

**Tests:** extend `base-hop.test.ts` and `outbound-quotes.serial.test.ts` (a payroll hop out of the account; refund fails payouts with no ledger row), `transit-sweep.test.ts` (request fields, session, no credit, dust), `transit-deposits.test.ts` (a hop's arrival is internal with a session and waits without one), `pretium-near-payouts.test.ts`.

Helpers: `makeNearPayoutWorld`, `deliverHop`.

### WP4: Treasury

**Owns:** `intents/treasury-quote.ts`, `intents/treasury-return.ts`, `treasury/advance.ts`, `intents/quote-credit.ts`.

**Tests:** extend `treasury-moves.serial.test.ts` (debit at `SUCCESS`; debit and credit at `REFUNDED`; reservation holds meanwhile), `treasury-to-wallet.serial.test.ts` (settlement credit completes the move), `quote-credit.serial.test.ts` (`from_treasury`; a sweep is never credited), `db/treasury-ledger.test.ts`.

Helpers: `helpers/treasury-moves.ts`, `helpers/money-in.ts`.

### Contracts between packages

- `advanceCompanyQuote`'s signature is unchanged. WP2, WP3 and WP4 call it as today.
- `ensureFeeCover` is imported by `quote-deposit.ts` and passed to `advanceIntentQuote`. Until WP1 lands, WP0 ships a stub in `fee-cover.ts` that compares the float and never tops up, and WP1 takes the file over.
- `isIntentPaid(quote)` is the only test WP2 and WP4 use to pick the ledger rule in B3.
- WP1 owns all of `near-deposits.ts`, including the two `readQuote` cases WP4 depends on.
- `confidential_quotes_to_credit` including `from_treasury` ships in WP0's migration.

### Phase 4, a second round

- P4a, API: `invoice-pdf.ts`, `bills/payment-receipt.ts`, `export/data.ts`, `export/treasury.ts`, `wallet/history.ts`, `withdrawal/withdrawals.ts`, shared schemas.
- P4b: web, mobile, admin payout page.
- P4c: runbook, decision record and `CONTEXT.md` updates, QA plan.

---

## F. Risks and open questions

### F1. Where a confidential company's payout could go wrong

**Paid twice**

| How                                                    | Covered?                                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same message submitted twice                       | Covered only if the ledger runs a nonce once. Assumed, not measured (F3.1)                                                                           |
| Two messages for one quote                             | The advisory lock and the guarded save. The residual is a crash between Privy's answer and the save, where the lost signature can't be submitted     |
| A payout retried while its old quote's message is live | The payout fails only when the quote is `failed`, `expired` or `refunded`. The database check keeps a signed quote from `failed` before its deadline |
| Direct send and quote for one NEAR payee               | The route is chosen once, at the funding barrier, and `followOnchainPayout` skips a payout with a delivery quote                                     |
| A hop refunded and its cash-out still funded           | `fundPaycrestPayout` needs the hop `succeeded` (`fund.ts:194-201`) and the USDC on Base (`:320-330`)                                                 |

**Debited without being paid**

| How                                              | Covered?                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| A USDC payout                                    | Not possible under B3: the debit and `paid` are one transaction on `SUCCESS`        |
| 1Click reports `SUCCESS` wrongly                 | The debit follows it, as credits do under decision 2. The alert shows "unexplained" |
| A Treasury part succeeds with no reported amount | Debited, and the move goes to review (`advance.ts:284-292`), as today               |

**Paid without being debited**

| How                                               | Covered?                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SUCCESS` arrives after the payout went to review | Not debited until staff hand it back (B8). The reservation still holds `maxDebitUsdc`, and the alert shows "short" |
| The settle transaction fails                      | Retried every 15 s; idempotent                                                                                     |

**Stuck**

| How                                                                                 | What then                                                                                                                               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted but never executed, or 1Click `FAILED`                                     | Review. Out by 1Click's word or the three-day deadline, then a hand-back                                                                |
| Sign-in down (Privy, the salt read, 1Click)                                         | Nothing starts or settles. Open quotes pass their deadlines into review. A long outage means many reviews, and nothing resolves a batch |
| Fee cover can't be delivered (relayer out of USDC, top-up refunded)                 | Quotes expire and payouts fail "nothing sent", retryable. Add the relayer's USDC balance to an existing alert                           |
| USDC still in the public wallet, with a move-in blocked by a `needs_review` move-in | Payouts expire for lack of balance                                                                                                      |
| An unregistered named NEAR payee                                                    | Fails, with today's message                                                                                                             |
| Hop delivered but the transit watcher can't hear it                                 | Fixed in B5; without that fix this one is certain                                                                                       |

### F2. Smaller things the code shows

- `ConfidentialAccounts.session` can't drop a cached token after a 401 (`confidential-account.ts:453-460`). A revoked token costs up to 15 minutes of failed calls.
- NEAR payees are paid one after another today (one send per wallet). They become parallel quotes: a 50-payee payroll is about 150 extra 1Click calls plus status polls. Rate limits are unknown.
- The first hop of a newly switched company waits for its first top-up. The job tops up any confidential company below the low mark, so this is under a minute after turn-on.
- `openCompanyQuote` and `openTreasuryQuote` gain a sign-in on the request path of an approval. A failure reads as "couldn't be quoted, nothing sent".
- A NEAR payee's receipt names a transaction from the shared account. That is the payee's side and stays public by decision.

### F3. Not knowable without NEAR Intents or mainnet

1. Is `submit-intent` safe to repeat with the same bytes, and what does it answer the second time?
2. What happens when the account holds less than the message moves: refused at submit, or accepted and never run?
3. A refund on the confidential route: where it lands, whether `refundedAmount` is the full deposit, and how long it takes.
4. Does a payout to NEAR need the recipient already registered with the USDC contract?
5. Is a message submitted after our 10-minute deadline, but inside 1Click's three days, refunded or delivered?
6. Does the hash `submit-intent` returns appear in the status's `intentHashes`? It would tie a message to its quote.
7. Exact-amount-out to NEAR out of the account. Avoided by design.
8. Rate limits on generate, submit, status and balances.
9. `/v0/account/history` access.

### F4. What each measurement changes

| Answer                                                                 | What it touches                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buffer returns to the account in about a minute, unreported (measured) | Nothing branches. Cost is `swappedAmountIn − amountOut`; the balance check absorbs the minute. `CONFIDENTIAL_SLIPPAGE_BPS` sizes the float                                                                        |
| Solana quotes (measured, dry)                                          | `destinationChain: PayeeChain`; no special case                                                                                                                                                                   |
| Confidential to confidential is free (measured, dry)                   | `startFeeCover` alone, if Expendi later pays cover from its own confidential account                                                                                                                              |
| Base into the account with an `ORIGIN_CHAIN` refund (measured, dry)    | Sweep and Move to wallet as designed                                                                                                                                                                              |
| NEAR payout free, in equals out (measured)                             | The `EXACT_INPUT` branch for NEAR payees in `openCompanyQuote`                                                                                                                                                    |
| A refund lands elsewhere or short (not measured)                       | One constant for the refund type in `openCompanyQuote` and `openTreasuryQuote`. The watcher already treats those purposes' transfers as internal, and the float formula already charges a short refund to Expendi |
| 1Click registers NEAR recipients itself (not measured)                 | Delete the `prepareRecipient` call in `deliverUsdcPayout`                                                                                                                                                         |
| Submit not repeatable (F3.1)                                           | One branch in S2: after the first attempt, read status instead of resubmitting                                                                                                                                    |

### Critical Files for Implementation

- `/Users/chizaa/Documents/projects/expendi/expendi-business-confidential/apps/api/src/services/intents/quote-deposit.ts`
- `/Users/chizaa/Documents/projects/expendi/expendi-business-confidential/apps/api/src/services/intents/confidential-account.ts`
- `/Users/chizaa/Documents/projects/expendi/expendi-business-confidential/apps/api/src/db/schema/intent-quotes.ts`
- `/Users/chizaa/Documents/projects/expendi/expendi-business-confidential/apps/api/src/services/payout/delivery.ts`
- `/Users/chizaa/Documents/projects/expendi/expendi-business-confidential/apps/api/src/services/wallet/deposits.ts`

## Decisions after the design

Taken 2026-11-13, with the mainnet measurements of the same day already folded into the design above.

1. **Decide (1): the literal rule stays.** A message that was signed and saved but never accepted waits in review until its own deadline has passed. No shortcut.
2. **Decide (2): Expendi absorbs sweep costs into the float**, as its surplus does today. No tolerance is added to the alert.
3. **Decide (3): moving a balance back out is not built in this round.** `turn-off` keeps refusing while the confidential account holds USDC, and its message says so. A move-out quote (the mirror of a move-in, measured free in the spike) is a later task. Until then a company that is turned on stays on.
4. **Fee cover is option (ii)**: a float per company in its confidential account, topped up by a relayer-paid delivery, with the constants proposed in B2 (target 1 USDC, low 0.25 USDC). The gas relayer on each environment has to hold enough USDC for it; staging's held 0.47 USDC on 2026-11-13.
5. **The ledger is written at the quote's outcome** (B3), not when 1Click accepts the message.
6. **`signIntent` signs only for exactly the quote's amount in** (finding 5).
7. Everything else is built as designed, including the findings at the top: the Base deposit watcher passes the session, the hold predicate no longer holds deposits behind a confidential payout or hop, and staff can hand a payout back after a confidential quote settles late.

**Changed while building**

8. The fee float is checked twice: once before a quote starts, which is what begins a refill, and again under the wallet row lock, so two quotes that start in the same instant can't both spend it.
9. The balance gate counts every message in flight until its quote settles, including ones 1Click has already carried out. It is safe and it is slow: a run of many USDC payouts that together come to more than half the balance waits for earlier ones to settle.
10. A refill is saved when a quote finds the float short and paid by the fee-covers job, not by the request that found it. It is the largest of the shortfall, the target less the float, and 0.05 USDC. After a refill is refunded or fails, the next waits 2 minutes. Before asking for a quote the job checks that the gas relayer holds enough USDC, and starts nothing if it doesn't.
11. A part of a Move to Treasury that was refunded with no usable amount writes nothing to the ledger and sends the move to review. The design had it write the debit first.
12. Staff's hand-back needs a fresh reading from 1Click only for a quote in review. A settled quote is final and the job stops asking about it, so for one the saved 1Click status has to agree with how it settled.
13. A payee on NEAR whose account can't be made ready fails the payout before anything is signed, rather than waiting and retrying as the direct transfer does.
14. A withdrawal's transaction is named by its chain only when it is the payee chain's delivery. One the company sent itself reads as it always did.
15. Not built: the Base delivery hash in the Treasury export, a Solana explorer link, and a transaction line in the mobile history list, which shows none today.
