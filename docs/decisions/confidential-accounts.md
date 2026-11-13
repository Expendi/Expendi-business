# Decision: a company can keep its USDC in a confidential account

_2026-11-13. Dennis, after the confidential-intents spike on mainnet (branch `spike/confidential-intents`)._

A company that asks for it keeps its USDC in a confidential account: its own account on the private ledger NEAR Intents runs (`intents.far`), reached through the 1Click API we already use. The company wallet stays as the company's public address and the key that signs for the confidential account. We chose this over leaving every balance in the public company wallet, which anyone who knows the account can read along with every USDC payout and payee, and over 1Click's `confidentiality` flag on its own, which by NEAR Intents' description hides only where a transfer between chains came from and leaves the balance public. Only the spike is built.

What stays public: the transit wallet and the Treasury wallet on Base, the payee's own receipt of a payment (amount and address), and the sender's side of a fund-in. A confidential account hides who paid, not that a payment happened.

This extends `near-main-chain.md`. Terms are defined in `CONTEXT.md`.

## Decided

Dennis accepted these on 2026-11-13.

1. **Per company, off by default, turned on by Expendi staff.** Nothing changes for a company that doesn't have it.
2. **The ledger is credited from 1Click, not from the chain.** A fund-in or invoice payment to a confidential account is credited when 1Click reports the quote `SUCCESS`, and checked against the balance 1Click returns. There is no chain to confirm it against. This replaces "confirmed at `FINAL`" for these companies.
3. **The company wallet stays as the public address.** USDC sent straight to it is credited as today, then moved in by a job. Turning the feature on is that job run over the whole balance.
4. **Sessions aren't stored.** The API signs in to 1Click when it needs to and keeps the access token in memory.
5. **A fund-in still refunds into the company's own public NEAR Intents account**, and the fund-in return sends it on to the confidential account.
6. **Cash-out and Treasury stay public on Base.**

## What was proved

`apps/api/scripts/spike-confidential-intents.ts`, run on 2026-11-13 on mainnet for Expendi Demo Co on staging:

- The company wallet signs in to 1Click with its Privy key through `PrivyWallets.nearSigner` and `signNep413Message`. No new dependency and no key registration. The access token lasts 15 minutes and the refresh token 7 days.
- USDC on NEAR into the confidential account: 0.3 USDC in, 0.3 credited, 20 seconds, no fee.
- Confidential account to Base: 0.1 USDC in, 0.095178 delivered, 29 seconds. That is about 0.0048 USDC fixed plus 2 bps.
- Confidential account to USDC on NEAR: 0.2 USDC in, 0.2 delivered, 13 seconds, no fee.
- A Base hop for an exact amount out (dry quote): 1.015072 USDC in for 1.000000 out.
- A sweep from Base and a fund-in from Base (dry quotes): 0.999798 out per 1 USDC, 35 seconds, 0.15 USDC minimum.
- None of the six NEAR transactions names the company account. They show amounts, a shared NEAR Intents account and the payee's address.
- Every confidential quote needs the partner key (`X-API-Key`) and the company's own session (`Authorization: Bearer`) together.
- `GET /v0/account/history` answers 403 "invite-only", even with the partner key.
- `confidentiality: basic` and `advanced` quote the same price and time as `public`. Nothing documents how they differ, so we don't use the flag.

Not proved: a payout to Solana, a refund on the confidential route, a transfer between two confidential accounts, and where the unused part of an exact-amount-out Base hop returns to.

## Rules

### Signing

1. **One function signs intents.** Only it may ask Privy to sign a message for a company. Before signing it checks that the message is addressed to `intents.far`, names the company as signer, moves only USDC, moves it only to the quote's deposit address, and moves no more than the quote's amount in and the spend cap.
2. **The message is known.** 1Click writes the message and the company wallet signs it. Captured from 1Click on 2026-11-13, it is a NEP-413 message addressed to `intents.far`. Its `signer_id` is the company's account. It holds exactly one intent, a `transfer` whose `receiver_id` is the quote's deposit address and whose only token is `imt:51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe:nep141:<the USDC contract>`, for exactly the quote's amount in. Its deadline is the quote's own deadline, three days out.
3. **The token's prefix account is pinned.** The account in that prefix is the shared NEAR Intents account that holds what backs every confidential balance. It is a constant in the signing function, so a message naming any other is refused.
4. **Save before submitting.** The signed message, its hash and its deadline are saved on the quote before `submit-intent` is called. A retry submits the same saved bytes. A new message for the same payout is built only after the saved one succeeded, was refunded, or passed its deadline.
5. **Three days is too long to wait.** A quote whose message was submitted and is neither settled nor refunded after its 1Click deadline is `needs_review`.

### The ledger

- The ledger stays the single source of a company's balance. The reconcile compares it with company wallet + transit wallet + confidential account.
- Moves between a company's own wallet and its own confidential account are not ledger entries. They are recorded with the Base hops and sweeps.
- For a company with a confidential account, a fund-in, a fund-in return or an invoice payment is credited once, when 1Click reports `SUCCESS`, and checked against the balance 1Click returns.

## What this costs us

- Privacy is from the public, not from NEAR Intents. It runs the private ledger on a permissioned set of validators. Nothing we have read says what its operators can see, so assume everything.
- A company's money becomes a claim on that ledger, backed 1:1, instead of USDC in its own account.
- Nobody outside can check the balance. The ledger and 1Click's answer are the only records, and `GET /v0/account/history` is invite-only, so staff can't read a confidential account's past from 1Click.
- Amounts and payee addresses stay public. When few others use the shared account, someone can match a payment by amount and time.
- Every payment, including one to a payee on NEAR, now goes through a 1Click quote and depends on 1Click being up.
- A payout to Base costs about 0.0048 USDC fixed plus 2 bps.
