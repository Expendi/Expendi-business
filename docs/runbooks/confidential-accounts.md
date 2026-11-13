# Runbook: confidential accounts

Read this when a company is being turned on or off, when the alert `confidential_balance_mismatch` opens, or when a NEAR Intents quote for a confidential company is in review.

**What is verified.** Everything here is read from the code in the working tree of branch `spike/confidential-intents` on 2026-11-13. That code is tested against fakes. Nothing from Phases 2 and 3 has run on staging, so no person has yet followed these steps. What was measured on mainnet is only what `docs/decisions/confidential-accounts.md` lists under "What was proved". Where this runbook says what a screen shows, that is read from the admin app's code, not seen. When the first live run (`docs/work/confidential-accounts/qa-plan.md`) shows something different, change this page.

Terms are in `CONTEXT.md`. The decision is in `docs/decisions/confidential-accounts.md`.

## 1. What a confidential account is

A confidential account is a company's own account on the private ledger NEAR Intents runs, where its USDC sits instead of in its public company wallet. The public can't read its balance or its payments; NEAR Intents can.

The company wallet stays as the company's public address and the key that signs for the account. It holds only what is waiting to be moved in, a few cents of dust, and any of Expendi's own surplus.

## 2. Turning a company on

Staging only. The script refuses any company but the one named in the staging configuration.

### Before you run it

1. Doppler `expendi-business`, config `stg`, holds `ONECLICK_API_KEY` (the partner key) and `CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID` set to the company's organization ID. For Expendi Demo Co that is the only company the script will switch.
2. The company has an active company wallet on NEAR.
3. Nothing of the company's is in flight (guard 6 below).
4. The gas relayer holds USDC for the company's fee float (section 7). Without it the company turns on, but its payouts to Base and Solana and its cash-outs expire.
5. A tunnel to the staging database is open:

```sh
npx -y @railway/cli@5.71.0 connect Postgres -e staging --tunnel-only -P 55433
```

### The command

```sh
DATABASE_URL=postgres://…@localhost:55433/… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/confidential-account.ts turn-on \
  --organization-id <organization id> --company-name "<company name exactly>" --yes
```

It prints the company's name and the database host first. It moves no money: it sets `wallets.balance_home` to `confidential_account` and writes the audit entry `wallet.balance_home_changed` (actor `confidential-account-script`).

On success it prints:

```
Balance home: confidential_account
Confidential account holds <x> USDC
The move-in job moves the company wallet's USDC on its next run.
```

### Every guard, in the order it applies

| #   | Refusal message                                                                                                                                                                          | What it means and what to do                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID must equal --organization-id. It is set only in the staging configuration`                                                                    | The variable is unset (you are not on staging) or names another company. Fix the variable, or stop: this script does not switch any other company.                                                                                                                                               |
| 2   | `Pass --company-name exactly as the company is named: "<name>"`                                                                                                                          | The name you typed differs from `organizations.name`. Copy it from the message.                                                                                                                                                                                                                  |
| 3   | `This changes where the company's USDC is kept. Run it again with --yes to go ahead`                                                                                                     | You left out `--yes`.                                                                                                                                                                                                                                                                            |
| 4   | `The company has no active company wallet on NEAR`                                                                                                                                       | The wallet is missing, not active, not on NEAR, or has no address or Privy wallet ID. Fix the wallet first.                                                                                                                                                                                      |
| 5   | `The company's balance home is already confidential_account` (or `company_wallet` for `turn-off`)                                                                                        | Nothing to do.                                                                                                                                                                                                                                                                                   |
| 6   | `Something of the company's is in flight: …` followed by a list such as `a move_in quote is depositing; a payout is funding; a Treasury move is open; a company wallet send is reserved` | An unsettled quote (`quoted`, `depositing` or `needs_review`), a payout that is `approved`, `order_created`, `funding` or `needs_review`, a Treasury move that is `open` or `needs_review`, or a company wallet send that is `reserved` or `signed`. Wait for it, or resolve it, then run again. |
| 7   | `The company's confidential account couldn't be read, so sign-in or the partner key is not working: <reason>`                                                                            | The script signs in to 1Click as the company and reads the account. This failed. Check `ONECLICK_API_KEY`, Privy, and the NEAR RPC. Do not switch the company until this reads.                                                                                                                  |
| 8   | `The company's confidential account still holds <x> USDC. Moving a balance back out of a confidential account isn't built yet, so a company that is turned on stays on until it is`      | Only `turn-off` gets this. See section 3.                                                                                                                                                                                                                                                        |

The script checks guards 6 and 8 a second time inside the transaction that changes the flag, holding the company wallet's row lock. A refusal there prints the same message.

### What happens after it is turned on

Two jobs run every 30 seconds. Neither needs a command.

1. **Move-in job.** It moves the company wallet's USDC into the account. It leaves Expendi's own surplus in the company wallet, and moves nothing when what is left is under 0.05 USDC. It moves in even parts that are each no larger than the company's per-transaction maximum, one part at a time. It does nothing while a hop, USDC payout or Move to Treasury paid from the company wallet is unsettled, while a company wallet send or a payout in `funding` exists, or while the company's payouts are paused. A move-in that ended `refunded` or `failed` rests 30 minutes. A move-in in `needs_review` blocks the next one until it settles.
2. **Fee-cover job.** It refills the company's fee float when it is under 0.25 USDC. For a new company the float is zero, so the first refill is 1 USDC. See section 7.

A move-in is not a ledger entry. The ledger balance does not change when it runs.

### How to confirm

1. Admin app, Companies, the company. The line under the wallet figures reads `Confidential account: not read yet` until the alerts job takes its first reading, then `Confidential account, as of <Nairobi time>: <amount>`.
2. Run the reconcile from the Treasury QA driver, which also prints the confidential account for a company that has one:

```sh
DATABASE_URL=postgres://…@localhost:55433/… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/treasury-qa.ts reconcile --organization-id <organization id>
```

Read it like this. Ledger balance is the company's money. After the move-in and the first float refill, company wallet plus transit wallet plus confidential account should exceed the ledger by exactly "Expendi's recorded surplus". It warns while anything is in flight; run it again when the warnings are gone.

## 3. Turning a company off

The command is the same with `turn-off` in place of `turn-on`. It is refused while the confidential account holds any USDC:

```
The company's confidential account still holds <x> USDC. Moving a balance back out of a confidential account isn't built yet, so a company that is turned on stays on until it is
```

Moving a balance back out is not built. There is no move-out job, no staff route and no screen that does it. The refusal reads the whole account, and Expendi's own fee float is inside the account, so once the float has been refilled the account never reads zero. In practice, a company that has been on for a minute stays on.

Do not set `wallets.balance_home` by SQL. The move-in job and the fee-cover job follow the flag, and the money would stay where it is.

## 4. What staff see and cannot see

### What you can see

- **Company page.** `Confidential account, as of <time>: <amount>`. This is the reading the alerts job saved on its last run, not a live call. If the "as of" time is old, the alerts job is not reading. Check System health.
- **NEAR Intents quote page.** For a quote paid out of the account: "Paid by: A signed message out of the company's confidential account", the message hash, the message deadline, when it was submitted, and the last 1Click status with its check time. The page never shows the signed message itself, because it stays spendable until its deadline. The 1Click NEAR transactions are labelled as the shared account's.
- **Alerts page.** The kind is "Confidential balance mismatch" and it links to the company.

### What you cannot see, and why

- **A live balance, or the account's history.** `GET /v0/account/history` answers 403 "invite-only" even with the partner key (measured 2026-11-13).
- **1Click's answer about a confidential quote.** 1Click answers a status call for one only to a session of the company's own account. With the partner key alone it answers 404 (measured 2026-11-13). Opening a session needs the company wallet to sign.

Staff code can't sign in, generate, sign or submit. `apps/api/src/__tests__/routes/internal-routes.test.ts` follows every import from the staff routes and fails if they reach the code that talks to Privy, or call `generateIntent`, `signIntent` or `submitIntent`. So the staff app shows what the API's own jobs last heard and saved, and the "Resolve" button for such a quote only hands payouts back (section 6).

### What the public can see

A confidential account hides who paid, not that a payment happened. What stays public: the transit wallet and the Treasury wallet on Base, the payee's own receipt of a payment (amount and address), and the sender's side of a fund-in. Measured on 2026-11-13: none of the six NEAR transactions of the spike names the company account. They show amounts, a shared NEAR Intents account and the payee's address.

## 5. The alert `confidential_balance_mismatch`

It compares, per company, the ledger with company wallet plus transit wallet plus confidential account. "Held less ledger" is that sum less the ledger.

The alert has two titles. "Confidential account doesn't match the ledger at <company>" is for the first two reasons. "Delivered payment missing from the ledger at <company>" is for the third.

### What the figures mean

| Figure in the alert        | Meaning                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ledger                     | The company's balance. The single source of truth.                                                                                                                                                                                                     |
| Company wallet             | USDC on NEAR in the public company wallet. Expected: waiting to be moved in, dust, and Expendi's surplus.                                                                                                                                              |
| Transit wallet             | USDC on Base in the transit wallet.                                                                                                                                                                                                                    |
| Confidential account       | What 1Click reports the account holds. Includes Expendi's fee float.                                                                                                                                                                                   |
| Held less ledger           | The sum of the three less the ledger, "of which Expendi's recorded surplus explains <x>". The surplus is Expendi's own USDC: the float in the account and whatever a hop left in the company wallet. A healthy company reads exactly the surplus here. |
| Delivered but not credited | Quote IDs that 1Click reports delivered and the ledger does not hold.                                                                                                                                                                                  |

### Each reason it fires

1. **Short.** Held less ledger is below zero. The ledger promises more than the company holds. This includes a float that Expendi's costs have spent below zero, because company money then pays Expendi's costs.
   - Check first: the company's recent payouts, sends and fund-ins. A delivery 1Click reported but never made shows up here.
   - Then: the float. If hops or sweeps cost more than it held and the gas relayer has no USDC, the float is not refilled (section 7). Refill the relayer.
2. **Unexplained.** Held less ledger is above Expendi's recorded surplus, and the excess is not USDC waiting in the company wallet (the company wallet holds no more than its own part of the surplus plus 0.05 USDC). That is USDC in the confidential account that no quote credited and no job will credit.
   - Check first: whether someone sent USDC straight into the account, whether 1Click revised an amount after the credit, and whether an old move-in delivered less than it took. There is no list of arrivals to read, so this needs engineering.
3. **Delivered but not credited.** A fund-in, invoice payment, fund-in return or Move to wallet return succeeded more than 10 minutes ago and has no ledger credit. This fires whatever the balances say.
   - Check first: the API log for `[quote-credit] quote <id> succeeded but 1Click reports … not credited`. 1Click reported no amount delivered, or more than was deposited, so the credit was refused. Give engineering the quote ID.

### What keeps it quiet, neither raised nor cleared

- A balance can't be read (1Click, sign-in, NEAR RPC or Base RPC down).
- Money is in flight: a move-in or float refill that is `depositing` or in review; a quote paid out of the account that is `depositing` or in review; a delivery to the account that is `quoted` and may have received a payment, `depositing`, in review, or succeeded less than 10 minutes ago and not yet credited; a company wallet send not final; a payout being funded; a Treasury move that is open, in review or settled in the last 30 minutes.
- A quote settled, or a ledger row was written, in the last 5 minutes.
- A `quoted` fund-in or pay-link quote that 1Click reported `PENDING_DEPOSIT` within the last 2 minutes does not count as in flight, so an open pay link doesn't silence the check for hours.

A later run that reads every balance and finds them agreeing clears the alert.

## 6. A quote in review

### How a quote gets there

A quote paid out of the account is in `needs_review` when 1Click reports `FAILED` after the message was accepted, or when 1Click still hasn't settled it 30 minutes after the quote's own deadline. The quote's deadline is the lesser of 1Click's and the 10 minutes Expendi asked for. The message's own deadline is much later: 1Click set three days out when it was captured on 2026-11-13, and the API refuses a message that expires more than four days out.

While a quote is in review, the payouts it holds are `needs_review` too, still reserving their USDC. Nothing is debited.

### What staff can and cannot resolve

Staff cannot ask 1Click and cannot resolve a quote that is still in `needs_review`. The page says so: it settles when the job hears `SUCCESS` or `REFUNDED` from 1Click, or fails once the signed message's deadline has passed. Resolve it after that. An `ops_viewer` can't resolve anything.

The three ways a quote leaves review, all by the job and none by staff:

1. 1Click reports `SUCCESS` (the quote becomes `succeeded`) or `REFUNDED` (`refunded`). This works from review, any time.
2. The message's own deadline plus 5 minutes passes while the job hears `PENDING_DEPOSIT` with no deposit recorded. The quote becomes `failed`: "The signed message expired unused. Nothing moved." The message is then dead and can never run. A database check refuses `failed` on a signed quote earlier than its message's deadline.
3. 1Click reported `FAILED`. The money is somewhere inside NEAR Intents. Ask NEAR Intents support. The quote stays in review until a person with database access corrects it by hand.

### What settles by itself, and when

| Situation                                                         | What the job does                                                                       | When                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Quote saved, deposit not started                                  | Waits for the fee float and for the balance. Ends `expired`, nothing moved, if too late | When under 3 minutes remain before the quote's deadline              |
| Nothing signed yet and under 3 minutes remain                     | Ends `failed`: "No message was signed before the quote's deadline. Nothing moved."      | Same                                                                 |
| 1Click refuses to generate the message, or Privy can't say        | Tries again                                                                             | Every 15 seconds                                                     |
| The message fails the API's checks, or Privy refuses              | Ends `failed`, nothing was signed                                                       | At once                                                              |
| Message signed and saved, not yet accepted                        | Submits the same saved bytes again, never a new signature                               | Every 15 seconds until 3 minutes before the quote's deadline         |
| Accepted                                                          | Reads 1Click's status                                                                   | Every 15 seconds                                                     |
| Unsettled long after the deadline, or `FAILED`                    | Moves to `needs_review`                                                                 | 30 minutes after the quote's deadline                                |
| Signed message past its deadline and 1Click still sees no deposit | Ends `failed`, nothing moved                                                            | The message's deadline plus 5 minutes, on a run where 1Click answers |

A signed message that was saved but never accepted waits in review until its own deadline has passed. No shortcut exists, by decision.

### Handing a held payout back after the quote settled late

Once the job has settled the quote (`succeeded`, `refunded` or `failed`) and a payout it held is still `needs_review`, an `ops_admin` can hand the payout back. The page offers "Resolve" only then.

1. Open the quote in the NEAR Intents list, then Resolve. Choose the outcome that matches how the job settled it: delivered for `succeeded`, refunded for `refunded`, never deposited for `failed`. Give a reason.
2. The review step lists what confirming does. Confirm it.
3. The API refuses if the outcome differs from what the job settled, if the last 1Click reading saved with the quote isn't `SUCCESS` or `REFUNDED` to match, or if the payout already has ledger rows ("That needs a ledger correction by hand"). It never signs, sends or changes the quote's own record.
4. A USDC payout goes back to `funding`. The delivery code then debits the ledger once and marks it paid with 1Click's delivery transaction as its reference (`succeeded`), or fails it with no ledger entry, because the refund went back into the company's account (`refunded`, `failed`). The company's admin can retry a failed payout.
5. The cash-outs held by a hop go back to `approved`. After a delivered hop the outbound quotes job funds them from the transit wallet. After a refunded or failed hop it fails them with nothing sent.

Never retry a payout while its quote is still open. The old signed message stays valid until its deadline and could still run.

## 7. The fee float

A Base hop or a USDC payout to another chain costs more than it delivers, and Expendi absorbs the difference. The fee float is a small amount of Expendi's own USDC kept inside the company's confidential account to pay it. A payout to a NEAR payee costs nothing and never waits for the float.

| Figure                                            | Value                                |
| ------------------------------------------------- | ------------------------------------ |
| Target (what a refill brings it to)               | 1 USDC per company that is turned on |
| Low-water mark (refill starts below)              | 0.25 USDC                            |
| Smallest refill                                   | 0.05 USDC                            |
| Wait after a refill that ended refunded or failed | 2 minutes                            |

A refill is a `fee_cover` quote. The gas relayer pays a 1Click deposit address with USDC on NEAR, and 1Click delivers it into the company's account for nothing, with the refund going back to the relayer. A refill is not a ledger entry. The float is not stored anywhere: it is worked out from the quotes (refills delivered, less what each hop, payout and sweep into the account cost). A quote in flight counts its whole difference, so two cannot spend the same float.

Each refill costs Expendi a USDC storage registration for its deposit address (0.00125 NEAR) plus relay gas.

### What the gas relayer must hold

- At least the refill amount in USDC when a refill starts. For a new company that is 1 USDC. So with N companies turned on, hold at least N USDC, plus room for hops. Staging's relayer held 0.47 USDC on 2026-11-13, which is less than one refill.
- NEAR for gas and storage registrations. The code sets no threshold; read it in the relayer's account.

### When the relayer is short

- The refill isn't started. The API log says `[fee-cover] the gas relayer holds less USDC than the <n> units <organization>'s float needs; nothing topped up`, or `…USDC balance is unreadable; nothing topped up`.
- A hop or payout whose cost the float can't cover waits. It expires when under 3 minutes remain before its quote's deadline, and its payout fails with nothing sent. The company's admin can retry.
- Payouts to NEAR payees are not affected.
- Fix: send USDC to the relayer. The next 30-second run refills.

### A refill that was refunded, or is in review

A refunded refill went back to the relayer, was never credited to the company, and waits 2 minutes before the next try. A refill in `needs_review` blocks further refills for that company until it is settled. The job settles it when 1Click reports `SUCCESS` or `REFUNDED`. For `FAILED`, ask NEAR Intents support. Whether the staff Resolve button accepts a refill quote has not been checked: hand it to engineering.

## 8. When 1Click or sign-in is down

Signing in takes Privy (to sign), the NEAR RPC (to read the contract's salt) and 1Click. Sessions are kept only in the API's memory and last about 15 minutes, so a restart signs in again by itself.

What stops:

- Move-ins and float refills don't start. The log says `couldn't sign … in to 1Click; nothing moved`.
- A payout to any payee, or a cash-out's hop, can't be quoted: the payout fails with "The payment couldn't be quoted: … Nothing was sent." The company's admin can retry once it is back.
- A fund-in or pay-link quote for a confidential company is expected to fail to open. This follows the Phase 2 design and was not checked in the code for this page.
- Quotes already open can't be read. They stay as they are, and a signed message that wasn't accepted is submitted again when 1Click is back.
- A delivery 1Click made can't be credited, because the credit waits for 1Click to report it.
- The alert stays as it is while a balance can't be read. The company page keeps the last saved reading and its "as of" time.

What resumes by itself: all of it, on the next 15 or 30-second run. Nothing is expired wrongly, because a quote expires only when 1Click answers that no payment arrived. A long outage does move every unsettled quote to review once it is 30 minutes past its deadline, and nothing resolves them in bulk. After the outage, work through the NEAR Intents list as in section 6.

## 9. Never

- Copy `signed_intent` anywhere. It is spendable until its deadline.
- Set `balance_home` by SQL.
- Retry a payout, or send by hand, while its quote is open.
