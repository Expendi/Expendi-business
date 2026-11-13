# Confidential accounts: keeping a company's balance off the public chain

**Status:** decisions accepted 2026-11-13 (Dennis). Phase 1 is built, tested and committed on branch `spike/confidential-intents`. Phases 2 to 4 are not started.

**Applies to:** the code on `staging`. Every file path below is on that branch.

**Read first:** `docs/decisions/near-main-chain.md` and `CONTEXT.md`. The spike is `apps/api/scripts/spike-confidential-intents.ts`.

---

## 1. What we're building

Today anyone who knows a company wallet's account can read its balance, every USDC payout and every payee. Enterprise customers don't want that.

A company that has this turned on keeps its USDC in a **confidential account**: its own account on the private ledger NEAR Intents runs (`intents.far`), reached through the 1Click API we already use. The public can't read it. The company wallet stays, holds nothing at rest, and becomes the key that signs for the confidential account.

**What stays public:** the transit wallet and the Treasury wallet on Base, the payee's own receipt of a payment (amount and address), and the sender's side of a fund-in. A confidential account hides who paid, not that a payment happened.

**Who can still see everything:** NEAR Intents, which runs the private ledger. This is privacy from the public, not from the operator.

## 2. What the spike measured (mainnet, 2026-11-13, Expendi Demo Co)

| Leg                                             | Result                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in with the company wallet's Privy key     | Works through `PrivyWallets.nearSigner` and `signNep413Message`. No new dependency, no key registration. Access token 15 minutes, refresh 7 days. |
| USDC on NEAR into the confidential account      | 0.3 USDC in, 0.3 credited, 20 s, no fee                                                                                                           |
| Confidential account to Base                    | 0.1 USDC in, 0.095178 delivered, 29 s (about 0.0048 USDC fixed, plus 2 bps)                                                                       |
| Confidential account to USDC on NEAR            | 0.2 USDC in, 0.2 delivered, 13 s, no fee                                                                                                          |
| Base hop for an exact amount out (dry quote)    | 1.015072 USDC in for 1.000000 out                                                                                                                 |
| Sweep from Base, fund-in from Base (dry quotes) | 0.999798 per 1 USDC, 35 s, 0.15 USDC minimum                                                                                                      |
| Public trace                                    | None of the six NEAR transactions names the company account. They show amounts, a shared NEAR Intents account and the payee's address.            |

Also measured:

- Every confidential quote needs the partner key (`X-API-Key`, `ONECLICK_API_KEY`) and the company's own session (`Authorization: Bearer`) together.
- `GET /v0/account/history` answers 403 "invite-only" even with the partner key.
- `confidentiality: basic` and `advanced` quote the same price and time as `public`. Nothing documents how they differ. This plan doesn't use the flag.
- 1Click writes the message the company wallet signs, addresses it to `intents.far`, and gives it a deadline three days out.

Not measured: a payout to Solana, a refund on the confidential route, a transfer between two confidential accounts.

## 3. Decided 2026-11-13 (Dennis)

All six were accepted as recommended.

1. **Per company, off by default, turned on by Expendi staff.** Nothing changes for a company that doesn't have it.
2. **The ledger is credited from 1Click, not from the chain.** A fund-in or invoice payment to a confidential account is credited when 1Click reports the quote `SUCCESS`, and checked against the balance 1Click returns. There is no chain to confirm it against. This replaces "confirmed at `FINAL`" for these companies, and reverses the reason `near-main-chain.md` gave for a public company wallet.
3. **The company wallet stays as the public address.** USDC sent straight to it is credited as today, then moved in by a job. Turning the feature on is the same job run over the whole balance.
4. **Sessions aren't stored.** The API signs in when it needs to and keeps the access token in memory. Nothing new to encrypt or leak.
5. **A fund-in still refunds into the company's public NEAR Intents account**, as today, and the fund-in return job sends it on to the confidential account. A refund is rare and shows only that the account exists.
6. **Cash-out and Treasury stay public on Base** in this version.

## 4. Rules

These extend `near-main-chain.md`. They go into a decision record before any code (task 13).

- **One function signs intents.** Only it may ask Privy to sign a message for a company. Before signing it checks that the message is addressed to `intents.far`, names the company as signer, moves only USDC, moves it only to the quote's deposit address, and moves no more than the quote's amount in and the spend cap.
- **Save before submitting.** The signed message, its hash and its deadline are saved on the quote before `submit-intent` is called. A retry submits the same saved bytes. A new message for the same payout is built only after the saved one succeeded, was refunded, or passed its deadline.
- **Three days is too long to wait.** A quote whose message was submitted and is neither settled nor refunded after its 1Click deadline is `needs_review`.
- **Moves between a company's own wallet and its own confidential account are not ledger entries.** They are recorded with the Base hops and sweeps.
- **The ledger stays the single source of a company's balance.** The reconcile compares it with company wallet + transit wallet + confidential account.

## 5. Tasks

### Phase 1: foundations (no behaviour change). Built 2026-11-13

1. **Record the message shape.** Run the spike's `pay` step once more printing the generated intent in full, and save it as a test fixture. Task 4 is written against it.
2. **Schema.** `wallets.balance_home` (`company_wallet` | `confidential_account`, default `company_wallet`). Add `CONFIDENTIAL_INTENTS` to `ONE_CLICK_ACCOUNT_TYPES` and a `move_in` purpose (`db/schema/intent-quotes.ts`). On `intent_quotes`: the signed message, its hash, its deadline and when it was submitted.
3. **1Click client** (`services/intents/one-click.ts`): `authenticate`, `balances`, `generateIntent`, `submitIntent`; quotes that deposit from, deliver to or refund to a confidential account; the session header. `RECIPIENT_TYPE` is hard-coded today.
4. **Sign-in and the signing guard** (new `services/intents/confidential-account.ts`): the versioned nonce (tested against the Intents SDK's layout), `current_salt` in `NearRpc`, an in-memory session per company, and the one function that signs intents under the rules above.

Phase 1 left two things for later phases. The check `intent_quotes_intents_side_matches_purpose` rejects a refund into a confidential account for a USDC payout, a Base hop and a move to Treasury, so phases 2 and 3 loosen it in their own migration. And `services/intents/confidential-account.ts` is now a third module allowed to ask Privy for a NEAR signer (`near-signing-boundary.test.ts`).

### Phase 2: money in, about 2 to 3 days

5. **Move-in job.** Company wallet to confidential account through `openCompanyQuote` / `advanceCompanyQuote` with purpose `move_in`, in amounts under the spend cap. Runs when staff turn the feature on and whenever the company wallet holds USDC.
6. **Fund-in and pay link** (`services/intents/fund-in.ts`, `services/invoices/pay-link.ts`): deliver to the confidential account, and credit the ledger when the quote settles rather than from the deposit watcher. The fund-in return (`services/intents/fund-in-return.ts`) delivers there too.
7. **Reconcile and balance read.** Add the confidential account to the reconcile and to staff's view of a company. Alert when the ledger and 1Click disagree.

### Phase 3: money out, about 3 days

8. **The deposit step** (`services/intents/quote-deposit.ts`): for a confidential company, `advanceCompanyQuote` generates, checks, signs, saves and submits a message instead of registering a deposit address and sending USDC. Fee cover has to reach the confidential account, not the company wallet: decide between a relayer move-in per hop and an Expendi float (open question 4).
9. **USDC payouts** (`services/payout/onchain.ts`, `services/payout/delivery.ts`): every payee chain goes through a quote, including NEAR, which is a direct transfer today.
10. **Base hop and sweep** (`services/payout/base-hop.ts`, `services/intents/sweep.ts`): hop out of the confidential account with `EXACT_OUTPUT`; sweep back into it; leave anything under 0.15 USDC in the transit wallet.
11. **Treasury** (`services/intents/treasury-quote.ts`): Move to Treasury starts from the confidential account; Move to wallet ends in it.

### Phase 4: what people see, about 1 to 2 days

12. **Receipts and exports.** Show the payee chain's transaction; no NEAR link for a confidential leg (`services/invoices/invoice-pdf.ts`, `services/invoices/link-payment.ts`, `services/export/data.ts`, the admin evidence page).
13. **Docs.** `docs/decisions/confidential-accounts.md`, the term in `CONTEXT.md`, a runbook for turning a company on and for a quote in review.
14. **Live QA on staging** with Expendi Demo Co: turn on, fund-in, invoice payment, each payout kind, a cash-out through each cash-out provider, a Treasury move each way, a forced refund.

About 8 to 10 working days for one person; 4 to 5 with parallel build sessions, since phases 2 and 3 only share phase 1.

## 6. Open questions for NEAR Intents

1. Can our partner key read `/v0/account/history`? Without it, staff can't see a confidential account's past from 1Click.
2. What do `basic` and `advanced` do?
3. What can the operators of the private ledger read, and is there an audit or technical description of it?
4. Can one confidential account pay another directly? It decides how Expendi covers hop fees (task 8).
5. Where does a refund land when a payout out of a confidential account fails?
