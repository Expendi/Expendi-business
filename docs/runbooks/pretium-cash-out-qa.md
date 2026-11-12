# QA plan: Pretium as a second cash-out provider

For PR #6 (`feat/pretium-cash-out`). The design is in `docs/decisions/pretium-cash-out-provider.md`.

Run this on **staging**, after the PR is merged and deployed. Pretium has no sandbox and NEAR Intents has no testnet, so Parts C, D and E move **real money**. Keep every cash-out small. The whole plan costs about KES 1,500 (about 12 USDC).

The automated suites already cover the logic with fakes. This plan exists to prove what fakes can't: how Pretium, Privy and Base behave for real. Part F lists those unknowns and the case that settles each one.

## Stop and switch back to Paycrest if

- USDC left the transit wallet and the cash-out is `needs_review`.
- A recipient is paid twice, or paid a different amount from the one approved.
- A refund comes back smaller than what was sent.
- The Controls page says Pretium's settlement address differs from the pinned one.

To roll back: Controls → Cash-out provider → switch to Paycrest with a reason. To stop everything: Controls → Pause every company's payouts. Record what happened before doing anything else to the cash-out.

## Before you start

- [ ] PR #6 is merged, staging is deployed, and migrations `0088` to `0091` ran in the pre-deploy step.
- [ ] An ops admin build that talks to the staging API (`https://api-staging-d6415b7f.up.railway.app`), with two staff accounts: one `ops_admin`, one `ops_viewer` (`apps/api/scripts/add-staff.ts`).
- [ ] A test company on staging with an active wallet and at least 15 USDC, an admin with a passkey, and one employee.
- [ ] Payees saved on that company:
  - an M-Pesa number you hold (so you see the SMS)
  - a Till, and a Paybill with an account number
  - a bank account at a bank Pretium pays, for example Equity or KCB
  - a bank account at a bank Pretium doesn't pay, for example Prime Bank
- [ ] An M-Pesa number that can't receive money (right format, not registered), for Part D.
- [ ] Access to Pretium's partner portal, and to the staging API logs on Railway.
- [ ] Doppler `expendi-business`, config `stg`: `PRETIUM_API_KEY` and `PRETIUM_CALLBACK_URL` are set. **Leave `PRETIUM_WEBHOOK_SIGNING_KEY` unset until case A3.**

## What to record for every live cash-out

Payout ID, provider, Base transaction hash, Pretium transaction code, M-Pesa or bank receipt, amount received, and the time of each step (approved, funded, Pretium told, paid). The ops admin payout page and the Audit log show all of them.

Audit entries a Pretium cash-out should leave, in order:

1. `payout.provider_changed` (only if it was prepared under the other provider)
2. `payout.funding_started`
3. `payout.funded`
4. `payout.pretium_transaction`
5. `payout.paid`

A refunded one ends instead with `payout.refund_requested`, `wallet.refund_received`, `payout.failed`.

## Part A: before switching (no Pretium money moves)

| ID  | Steps                                                                                                                                                                                            | Expected                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Open Controls as the `ops_admin`.                                                                                                                                                                | A "Cash-out provider" card. Paycrest is Active and Ready. It says the provider was never changed.                                                                                                                              |
| A2  | Open Controls as the `ops_viewer`.                                                                                                                                                               | The same state, with no button to change it.                                                                                                                                                                                   |
| A3  | With the signing key still unset, look at Pretium on the card. Then create the signing key in Pretium's portal, add `PRETIUM_WEBHOOK_SIGNING_KEY` to Doppler `stg`, restart the API.             | Before: Pretium is Not ready, the card says the signing key isn't set, and the button is disabled. After: Pretium is Ready and the button "Send new cash-outs through Pretium" is enabled.                                     |
| A4  | As the `ops_admin`, start the change to Pretium with a 5-character reason.                                                                                                                       | Refused: the reason needs at least 10 characters. Nothing changes.                                                                                                                                                             |
| A5  | Start the change with a proper reason, reach the confirmation step, then wait 6 minutes before confirming.                                                                                       | Refused as expired (the confirmation lasts 5 minutes). Paycrest is still active.                                                                                                                                               |
| A6  | Pay one M-Pesa cash-out of KES 50 from the web app while Paycrest is active.                                                                                                                     | Paid as before this change. The ops payout page shows provider Paycrest. This is the regression baseline.                                                                                                                      |
| A7  | In the web app and the mobile app, open: wallet, overview, a claim approval, a bill payment, a payroll run, a petty cash top-up, add payee.                                                      | No screen names Paycrest or Pretium. You see "Cash-out fee, at most" and "Rate today". Mobile needs a build from this branch; an older install still says "Paycrest".                                                          |
| A8  | Add a bank payee. Count the banks in the picker.                                                                                                                                                 | 40 banks. Saving works.                                                                                                                                                                                                        |
| A9  | Send an unsigned callback: `curl -i -X POST https://api-staging-d6415b7f.up.railway.app/webhooks/pretium -H 'Content-Type: application/json' -d '{"transaction_code":"qa","status":"COMPLETE"}'` | HTTP 401. Within a minute the Alerts page shows "Pretium webhook failed signature verification", and System health shows the incident under "Pretium webhook signatures". This alert is expected; note it so nobody chases it. |

## Part B: switching to Pretium

| ID  | Steps                                                                                                       | Expected                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | In the web app, submit a claim and get it to "waiting for approval". **Don't approve it.** Call it claim X. | The claim waits. In the ops payout queue its payout shows provider Paycrest.                                                                                                                                                 |
| B2  | As the `ops_admin`, change the provider to Pretium. Read the review step before confirming.                 | The review says new cash-outs go through Pretium, counts at least 1 cash-out waiting for approval, says 20 of 40 banks can't be paid through Pretium, and states the KES 250,000 limit. After confirming: Pretium is Active. |
| B3  | Open the Audit log.                                                                                         | One `platform.cash_out_provider_changed` entry under your name, with your reason, before Paycrest, after Pretium.                                                                                                            |
| B4  | Open the wallet in the web app.                                                                             | "Rate today" now shows Pretium's rate. It will differ a little from the rate in A6.                                                                                                                                          |
| B5  | Try to change to Pretium again.                                                                             | Refused: Pretium is already the active provider.                                                                                                                                                                             |

## Part C: live Pretium cash-outs

Do C1 first and finish it before the others. If C1 fails in a way Part F doesn't expect, stop.

| ID  | Steps                                                                                                 | Expected                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Approve claim X from B1 (M-Pesa number you hold, KES 100).                                            | The Audit log shows `payout.provider_changed` (Paycrest to Pretium). The phone gets exactly KES 100. The payout is `paid` with the M-Pesa receipt. The ops payout page shows provider Pretium, a transaction code, status COMPLETE, and a Base transfer to `0x8005ee53e57ab11e11eaa4efe07ee3835dc02f98`. The company sees the claim as paid. |
| C2  | Pay a bill of KES 50 to the Till.                                                                     | Paid. The till receives KES 50.                                                                                                                                                                                                                                                                                                              |
| C3  | Pay a bill of KES 50 to the Paybill with its account number.                                          | Paid, credited to that account number.                                                                                                                                                                                                                                                                                                       |
| C4  | Pay a bill of KES 150 to the bank account at the bank Pretium pays.                                   | Paid. The bank account receives KES 150. Record how long it took.                                                                                                                                                                                                                                                                            |
| C5  | Run payroll for two people, KES 60 and KES 80, to M-Pesa.                                             | One Base hop for the total, two Pretium transactions, both paid.                                                                                                                                                                                                                                                                             |
| C6  | Top up a petty cash float by KES 50.                                                                  | Paid to the holder's M-Pesa.                                                                                                                                                                                                                                                                                                                 |
| C7  | Try to pay a bill of KES 19, then one of KES 20.                                                      | KES 19 is refused before approval with a plain message. KES 20 is paid.                                                                                                                                                                                                                                                                      |
| C8  | Enter a bill of KES 250,001 to M-Pesa and ask to pay it. **Don't fund the wallet for it.**            | Refused when it is prepared: "A single payment can send at most KES 250,000.00. Split it into smaller payments." No approval is asked for.                                                                                                                                                                                                   |
| C9  | Pay a bill of KES 150 to the bank account at the bank Pretium doesn't pay.                            | Refused before anything is sent: "That bank can't be paid right now. Choose another bank or another way to pay." The wallet balance doesn't change.                                                                                                                                                                                          |
| C10 | With Pretium active, pause every company's payouts on Controls, try to approve a claim, then unpause. | Refused: "Payouts are paused. Nothing was sent." After unpausing, the same claim can be approved and is paid.                                                                                                                                                                                                                                |

For every paid case, check on the ops payout page:

- [ ] The wallet history shows one debit, and it equals the shillings divided by the rate, rounded up to the sixth decimal.
- [ ] The cash-out fee shown to the company after payment is zero.
- [ ] System health shows a recent run under "Checks cash-outs against Pretium every minute".

If Zoho Books is connected on staging, check that one paid bill posts with its receipt number.

## Part D: a cash-out that fails after the USDC is sent

| ID  | Steps                                                                                          | Expected                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Approve a claim of KES 100 to the M-Pesa number that can't receive money.                      | The USDC is sent. Pretium either refuses when told or reports FAILED soon after. The payout stays "paying" and the ops payout page shows a refund requested, once.                                                                                                                    |
| D2  | Wait for the refund. Check the ops payout page each minute for up to 30 minutes.               | The refund arrives in the company's transit wallet. The Audit log shows `wallet.refund_received`. The payout becomes `failed` with "The cash-out didn't go through. The USDC is back in the company wallet." The company's balance in the app is back to what it was before D1.       |
| D3  | Record the refund: the address it came from, the amount, its hash, and the hash Pretium named. | The amount equals what was sent. If it is smaller the payout goes to `needs_review` instead: stop, this is a finding (Part F, item 1).                                                                                                                                                |
| D4  | In the web app, retry the failed claim after correcting the number.                            | A new payout through the provider active now. Paid.                                                                                                                                                                                                                                   |
| D5  | Only if a payout reaches `needs_review` during this plan: open it in the ops admin.            | The evidence shows the Base transfer, Pretium's transaction and the refund state. "Paid" is refused unless Pretium reports it complete for that transfer. "Failed" is refused unless nothing was sent or the full refund is back. Resolving needs a reason and a second confirmation. |

The sweep only moves a transit wallet balance above 1 USDC. After a KES 100 refund the USDC may stay in the transit wallet. That is expected: the company's balance covers both wallets.

## Part E: switching back, with cash-outs in flight

| ID  | Steps                                                                                                                                                                                           | Expected                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| E1  | As the `ops_admin`, start the change back to Paycrest and stop at the confirmation step. In the web app approve a KES 50 M-Pesa claim. Then confirm the change straight away, within 5 minutes. | The claim was approved under Pretium, so it finishes through Pretium and is paid. Controls shows Paycrest active. |
| E2  | Submit and approve another KES 50 M-Pesa claim.                                                                                                                                                 | Paid through Paycrest.                                                                                            |
| E3  | Pay the KES 150 bill from C9 (the bank Pretium doesn't pay).                                                                                                                                    | Paid through Paycrest.                                                                                            |
| E4  | Open the wallet in the web app.                                                                                                                                                                 | "Rate today" shows Paycrest's rate again.                                                                         |
| E5  | Open the Audit log.                                                                                                                                                                             | A second `platform.cash_out_provider_changed` entry: before Pretium, after Paycrest, with your reason.            |

## Part F: what this plan must find out

| #   | Question                                                                | Settled by | What to write down                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Where does Pretium's refund land, and is it the full amount?            | D2, D3     | Sender address, amount sent, amount refunded, minutes taken, whether the hash matched the one Pretium named.                                                                               |
| 2   | Does Pretium accept the phone number as `2547…`?                        | C1         | Paid, or the refusal text from the Audit log.                                                                                                                                              |
| 3   | Does Privy return a normal Base transaction hash for a sponsored send?  | C1         | Seconds between `payout.funded` and `payout.pretium_transaction`. More than a minute, or a `payout.tx_hash_found` entry, means the hash came late.                                         |
| 4   | Does Pretium accept a hash seconds after the transfer is mined?         | C1 to C6   | Any case where the first cash-out to a good recipient asks for a refund. That is a serious finding: stop.                                                                                  |
| 5   | Do Pretium's callbacks arrive, signed with the header the code expects? | C1 to C6   | In each `payout.paid` audit entry, whether the source is `webhook` or `reconcile`. All `reconcile` means callbacks aren't arriving or are failing the signature check: check the API logs. |
| 6   | How long does each rail take?                                           | C1 to C6   | Minutes from approval to paid, for M-Pesa, Till, Paybill and bank.                                                                                                                         |

Not covered live, because each needs more than KES 250,000 or a fault we can't cause on demand: a payroll salary split at KES 250,000, a changed settlement address, a reverted Base transfer, and a Pretium outage mid cash-out. The automated suites cover these with fakes (`pretium-payouts.test.ts`, `pretium-cash-out-e2e.serial.test.ts`, `cash-out-provider-engine.serial.test.ts`).

## Sign-off

| Part                      | Passed | Findings |
| ------------------------- | ------ | -------- |
| A: before switching       |        |          |
| B: switching              |        |          |
| C: live cash-outs         |        |          |
| D: failure and refund     |        |          |
| E: switching back         |        |          |
| F: all six answers filled |        |          |

Leave staging on Paycrest when you finish, unless the answers in Part F are all clean and Dennis says to keep Pretium active.
