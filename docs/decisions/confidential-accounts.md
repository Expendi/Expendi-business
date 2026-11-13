# Decision: a company can keep its USDC in a confidential account

_2026-11-13. Dennis, after the confidential-intents spike on mainnet (branch `spike/confidential-intents`)._

A company that asks for it keeps its USDC in a confidential account: its own account on the private ledger NEAR Intents runs (`intents.far`), reached through the 1Click API we already use. The company wallet stays as the company's public address and the key that signs for the confidential account. We chose this over leaving every balance in the public company wallet, which anyone who knows the account can read along with every USDC payout and payee, and over 1Click's `confidentiality` flag on its own, which by NEAR Intents' description hides only where a transfer between chains came from and leaves the balance public. Phases 1 to 3 are built (the signing guard, money in, money out) and tested against fakes on that branch, and the staff pages that show a confidential company are in its working tree. None of it has run on staging. What has run on mainnet is the spike's own calls and the measurements under "What was proved". The runbook is `docs/runbooks/confidential-accounts.md`.

What stays public: the transit wallet and the Treasury wallet on Base, the payee's own receipt of a payment (amount and address), the sender's side of a fund-in, and everything the company wallet did before it was turned on. A move-in is public too: it is a transfer out of the company wallet, with its amount, to a NEAR Intents deposit address. A confidential account hides who paid, not that a payment happened.

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

Measured later on 2026-11-13, on mainnet, for the same company. Each is a dry quote or a read, so nothing moved, except the exact-amount-out hop, which moved real money:

- A fund-in from Base that delivers to the confidential account and refunds into the public NEAR Intents account quotes: 0.999798 per 1 USDC, 35 seconds.
- A fund-in return paid from the public NEAR Intents account into the confidential account quotes: 0.999798 per 1 USDC, 10 seconds.
- A move-in of 0.01, 0.05 and 0.15 USDC each quotes with nothing taken.
- `GET /v0/status` for a confidential quote answers 404 with the partner key alone, and 200 with a session of the same account opened hours after the quote was made.
- A second sign-in does not end the first.
- An exact-amount-out hop of 0.1 USDC to Base, with real money, took 0.105882 from the confidential account and delivered exactly 0.100000 in 23 seconds. The status reported 104823 as the amount used and no refund. The unused 1059 was back in the confidential account about a minute later.
- A payout to Solana out of a confidential account quotes: 0.989765 per 1 USDC, 7 seconds.
- A transfer between two confidential accounts quotes free, in 10 seconds.
- USDC on Base into a confidential account with a refund to Base quotes: 0.999798 per 1 USDC, 35 seconds.

Not proved: a refund on the confidential route (where it lands, whether the whole payment comes back, how long it takes), and a payout to a NEAR account that is not registered for USDC. A payout to Solana, a transfer between two confidential accounts and the other routes above that were only quoted have not been run with money. Everything built on top of these calls, Phases 2 and 3, has run only against fakes.

## Rules

### Signing

1. **One function signs intents.** Only it may ask Privy to sign a message for a company. Before signing it checks that the message is addressed to `intents.far`, names the company as signer, moves only USDC, moves it only to the quote's deposit address, and moves exactly the quote's amount in, which must not be above the spend cap. A message for less than the amount in is refused too: both messages captured on 2026-11-13 move exactly the amount in, and anything else is unexpected.
2. **The message is known.** 1Click writes the message and the company wallet signs it. Captured from 1Click on 2026-11-13, it is a NEP-413 message addressed to `intents.far`. Its `signer_id` is the company's account. It holds exactly one intent, a `transfer` whose `receiver_id` is the quote's deposit address and whose only token is `imt:51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe:nep141:<the USDC contract>`, for exactly the quote's amount in. Its deadline is the quote's own deadline, three days out.
3. **The token's prefix account is pinned.** The account in that prefix is the shared NEAR Intents account that holds what backs every confidential balance. It is a constant in the signing function, so a message naming any other is refused.
4. **Save before submitting.** The signed message, its hash and its deadline are saved on the quote before `submit-intent` is called. A retry submits the same saved bytes. A new message for the same payout is built only after the saved one succeeded, was refunded, or passed its deadline. A retry of a payout is a new payout with a new quote, and a quote fails only when nothing was signed, or when the message's own deadline has passed (plus 5 minutes) with 1Click still reporting no deposit. The database refuses `failed` on a signed quote settled before its message's deadline.
5. **Three days is too long to wait.** A quote with a signed message that is neither settled nor refunded 30 minutes after the quote's own deadline, or that 1Click reports `FAILED`, is `needs_review`. It leaves review when 1Click reports `SUCCESS` or `REFUNDED`, or fails once its message's deadline has passed. A message that was signed and saved but never accepted waits there too: no shortcut.
6. **Only canonical text is signed.** The message is refused unless it is written the one way its contents can be. A repeated key or other non-canonical text could be read one way by the API and another by the ledger, so only text that writes back out unchanged is trusted.
7. **Staff code cannot sign in, generate, sign or submit.** Staff routes can't reach the code that talks to Privy, and a test fails if they call `generateIntent`, `signIntent` or `submitIntent`. Staff see what the jobs last heard.

### The ledger

- The ledger stays the single source of a company's balance. The reconcile compares it with company wallet + transit wallet + confidential account.
- Moves between a company's own wallet and its own confidential account are not ledger entries. They are recorded with the Base hops and sweeps.
- For a company with a confidential account, a fund-in, a fund-in return or an invoice payment is credited once, when 1Click reports `SUCCESS`, and checked against the balance 1Click returns. A Move to wallet's return from Treasury is credited the same way, as `from_treasury`. The credit is for the amount 1Click says it delivered, names the quote, and carries no chain transaction. The credit is refused, and logged, when that amount is missing or above what was paid in.
- **A payment out of the account is written at the quote's outcome, not when 1Click accepts the message.** Acceptance is not proof the transfer ran, and a payout debited on it and never run would be debited without being paid.
  - `SUCCESS`: a USDC payout or withdrawal is debited for exactly the approved USDC and marked paid in one transaction. A Move to Treasury part is debited its amount in, then the vault deposit follows.
  - `REFUNDED`: the payout fails and nothing is written, because the refund went back into the account. A Move to Treasury part is debited and credited the refunded amount in one transaction.
  - `needs_review`: the payout stays under review and keeps its reservation, and nothing is debited. When the quote settles late, staff hand the payout back and the delivery code applies the outcome.
  - A cash-out's Base hop writes nothing. The debit is the transit wallet's send, as for a public company.
- **The account's balance gates every payment out.** Approval reads the ledger, which also counts USDC still waiting in the company wallet to be moved in, and the unused buffer of a hop is out of the account for about a minute (measured). So before a quote is paid, the API reads the account and waits unless it holds the quote's amount in plus the amounts in of the wallet's other quotes still in flight.

### Expendi's fee float

- A Base hop or a USDC payout to Base or Solana costs more than it delivers, and Expendi, not the company, absorbs the difference. A payout to a NEAR payee costs nothing.
- A confidential account can't be sent to on chain, so Expendi keeps a **fee float** of its own USDC inside each company's account. It is not a ledger entry and never part of the company's balance. It is worked out from the quotes: refills delivered, less what each hop and payout paid out of the account cost, less what each sweep into it cost. A quote in flight counts its whole difference, so two cannot spend the same float.
- The target is 1 USDC per company that is turned on. A refill starts when the float falls below 0.25 USDC, or when a hop or payout needs more than the float holds.
- A refill is a free USDC-to-USDC delivery into the account, paid by the gas relayer, with the refund going back to the relayer. The relayer has to hold the USDC (staging held 0.47 USDC on 2026-11-13). When it doesn't, no refill starts and a quote that needs the float expires with nothing sent.
- Expendi absorbs sweep costs into the float. If costs spend it below zero, company money is paying Expendi's costs, and the alert shows the company as short.

### Staff

- Staff can't ask 1Click about a confidential quote, read the balance live or read the account's history. They see the balance the alert check last saved, with its time, and the last status the job heard for each quote.
- A quote in review is settled by the job. Staff can only hand back the payouts it held after it settled, and only with the outcome the job settled it as, so money 1Click delivered can never be handed back as refunded or never sent.

## What this costs us

- Privacy is from the public, not from NEAR Intents. It runs the private ledger on a permissioned set of validators. Nothing we have read says what its operators can see, so assume everything.
- A company's money becomes a claim on that ledger, backed 1:1, instead of USDC in its own account.
- Nobody outside can check the balance. The ledger and 1Click's answer are the only records, and `GET /v0/account/history` is invite-only, so staff can't read a confidential account's past from 1Click.
- Amounts and payee addresses stay public. When few others use the shared account, someone can match a payment by amount and time.
- Every payment, including one to a payee on NEAR, now goes through a 1Click quote and depends on 1Click being up.
- A payout to Base costs about 0.0048 USDC fixed plus 2 bps.
- Turning a company off isn't built. `turn-off` refuses while the account holds any USDC, and Expendi's own fee float sits in the account, so a company that has been turned on stays on. Moving a balance back out (a move-out quote, the mirror of a move-in, which was measured free in the spike) is a later task.
- A payroll run of many USDC payouts can run slower. Each payout is its own quote, where a NEAR payee was one direct transfer, and a quote is paid only when the account holds its amount in plus that of every other quote of the wallet still in flight. A quote that waits past its deadline expires and its payout fails with nothing sent. The company's admin can retry it. Rate limits on 1Click's calls for a large payroll are unknown.
- Each move-in and each fee float refill costs Expendi a storage registration (0.00125 NEAR) for its deposit address, plus relay gas, and the float itself is Expendi's USDC inside the account, where NEAR Intents can see it.
- A staff member can't settle a confidential quote that is stuck in review, or look into it live. It waits for the job, for 1Click, or for the message's own deadline, up to three days.
