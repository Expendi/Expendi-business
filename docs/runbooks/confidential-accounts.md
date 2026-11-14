# Runbook: confidential accounts

The decision is in `docs/decisions/confidential-accounts.md`; terms are in
`CONTEXT.md`. This runbook includes the confidential-default build on
`feat/confidential-default`. That build has local fake-provider tests; its
rollout and move-out have not been exercised live.

The earlier session reported C1/C2 passed on staging for Expendi Demo Co and
C3 stopped before funding the fee float. Those are historical results.

## 1. Enable the environment's default

`CONFIDENTIAL_ACCOUNTS_ENABLED=true` enables:

- New company wallets with `balance_home=confidential_account`.
- A job that admits one existing eligible NEAR company every 30 seconds.

Unset or false leaves new wallets public and stops automatic admission.
Changing it requires restarting/redeploying the API. It does not switch
existing confidential companies back, stop their payments, or stop rollbacks.
The migration itself moves no money and changes no existing balance home.
Legacy Base-only wallets are not eligible; they need the NEAR migration first.

Before admission, the company's confidential account must be readable and the
relayer must hold enough USDC for its 1-USDC float plus outstanding float
targets of previously admitted companies. A refill remains reserved until it
settles, even if its transfer already left the relayer. This is deliberately
conservative. The relayer also needs NEAR for gas and storage registrations;
this check measures USDC, not NEAR gas.

A new wallet that fails readiness still activates, on its company wallet, so
the company can take money at once. The log line starts `[wallet]` and names
the reason. The rollout job turns it confidential once the relayer can fund
its float. Existing companies wait if quotes, reserving payouts,
sends, Treasury moves or confidential ledger credits are unfinished. The job
rotates candidates so a blocked company does not indefinitely block the rest.
Its log prefix is `[confidential-rollout]`.

## 2. Manually turn a company on

Run against the intended environment and database:

```sh
DATABASE_URL=postgres://… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/confidential-account.ts turn-on \
  --organization-id <id> --company-name "<exact company name>" --yes
```

Turn-on requires the environment switch, or the legacy pilot variable
`CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID` matching this company. The pilot
variable is read by the script; changing it does not require an API restart.
Both paths now require relayer funding.

The command prints the company and database host. It requires an active NEAR
wallet, exact company name, `--yes`, an empty in-flight list, readable
confidential balance, and funding capacity. Checks and the change are protected
by locks; the audit is in the same transaction.

Turn-on clears an earlier rollback opt-out. Audit action:
`wallet.balance_home_changed`.

Afterward, the existing move-in and fee-cover jobs:

- Move public USDC into the confidential account in capped parts, leaving
  Expendi's public surplus and dust below 0.05 USDC. No ledger entry.
- Refill the fee float toward 1 USDC, starting below 0.25 USDC or when needed
  for a payment. Minimum refill is 0.05 USDC. No ledger entry.

## 3. Turn a company off

```sh
DATABASE_URL=postgres://… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/confidential-account.ts turn-off \
  --organization-id <id> --company-name "<exact company name>" --yes
```

Rollback is available even with the environment switch off, and is not
restricted to the pilot company. It still requires the exact name, confirmation,
an active NEAR wallet, readable balance and no unfinished money operations.
A negative fee float must be refilled first.
Recently successful confidential exact-output quotes also wait five minutes
for their unused buffers to return, matching the reconciliation quiet period.

If the account and its recorded float are empty, the command switches
immediately. Otherwise it records `wallet.move_out_requested` and sets
`balance_home_changing=true`. The balance home stays confidential while draining.

During the drain:

1. New quotes, company-wallet sends, reserving payouts and Treasury moves wait.
   Move-ins and fee-float refills stop.
2. The `balance-home-changes` job runs every 30 seconds, requesting one free,
   capped, exact-input `move_out` at a time to the same public NEAR account.
3. The existing intent signer validates the message and saves it before
   submission. Restarts reuse the saved quote and signature.
4. A refund keeps money in the confidential account. Refunded, failed or
   expired attempts wait 30 minutes before a fresh attempt.
5. A quote in review blocks replacement. Missing or short delivered amounts
   are also held for review. Provider-refused dust leaves the drain pending.
6. Completion requires no unsettled quote and a fresh zero account balance.
   Any confidential float still recorded then was never in the account: it is
   added to `wallets.confidential_float_written_off_usdc`, logged as
   `[move-out] ... written off`, and named as `floatWrittenOffUsdc` in the
   `wallet.balance_home_changed` audit entry. Look into any write-off: it means
   Expendi recorded float that wasn't there. A turn-off of an empty account
   with a recorded float drains the same way, without a move-out.

The whole balance includes Expendi's fee float. That float becomes recorded
public-wallet surplus; it is not credited to the company or sent to the relayer.
The ledger must be identical before and after. The deposit watcher treats
move-out receipts as internal transfers.

`confidential_opt_out=true` persists after rollback. Automatic rollout skips
the company until an explicit `turn-on` clears it.

### Inspect progress

```sh
DATABASE_URL=postgres://… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/confidential-account.ts status \
  --organization-id <id>
```

This reads saved wallet state and move-out quote IDs, statuses and failures.
It does not sign in or send money. `confidentialUsdc` is the last saved
reading, not necessarily current; check `readAt`.

For a fresh reconciliation:

```sh
DATABASE_URL=postgres://… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/treasury-qa.ts reconcile \
  --organization-id <id>
```

Do not clear the transition flag or switch the balance home with SQL to
unstick it. Check saved quotes and provider outcomes first.

## 4. Balance mismatch alerts

`confidential_balance_mismatch` compares the ledger with company wallet +
transit wallet + confidential account. Held less ledger should equal Expendi's
recorded surplus. The fee float is included in holdings, not in the ledger.

- **Short:** inspect recent payouts, sends, fund-ins and a depleted fee float.
- **Unexplained excess:** inspect all three holdings and their transfers.
  Excess can be in the transit wallet as well as the confidential account.
  The earlier staging run reported relayer test money in the transit wallet.
- **Delivered but not credited:** a confidential fund-in, invoice payment,
  fund-in return or Treasury return succeeded over 10 minutes ago without a
  ledger credit. Check `[quote-credit]` logs and give engineering the quote ID.

Unreadable balances, money in flight and recent activity can keep an alert
unchanged. The ordinary post-activity quiet period is five minutes. A later
clean reading clears it. Staff see the last saved balance and its timestamp.

## 5. Quotes in review and outages

After a signed message was accepted, `FAILED` from 1Click does not prove money
returned. The quote stays in review. An unsettled quote also enters review
30 minutes after its quote deadline. A saved signed message may remain
spendable for days.

The job can settle late `SUCCESS`/`REFUNDED`, or fail an unused message only
after its own deadline plus five minutes when 1Click reports no deposit.
A short move-out delivery remains in review until a full delivery is reported
or engineering reconciles it.

Staff routes cannot sign in, sign or submit. They show saved evidence. For a
settled payout quote, staff can hand a held payout back only with the matching
outcome; a payout with existing ledger rows requires manual reconciliation.
Move-outs have no payout to hand back. Escalate ambiguous ones to engineering.

When 1Click or sign-in is down, new quotes and balance reads fail, and saved
quotes wait. Jobs retry; the alert retains its previous state. Never replace a
quote while its signed message can still run.

When the relayer is short, fee refills wait. Payments needing fees can expire
without being sent. Free NEAR payouts do not need the float. Refill the relayer
and let the job resume. Refunded refills wait two minutes before retrying.

Never copy `signed_intent` into logs or support messages: it remains spendable.
