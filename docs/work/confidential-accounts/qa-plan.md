# Confidential accounts QA plan: Phases 1 to 4

**Status:** draft, 2026-11-13. Nothing in this plan has been run on staging yet.

**Covers:** what is built on branch `spike/confidential-intents`, in the uncommitted working tree:

- **Phase 2, money in:** turning a company on with `scripts/confidential-account.ts`, the move-in job, the settlement credit for a fund-in, an invoice payment through the pay link and a fund-in return, the reconcile and the alert `confidential_balance_mismatch`, and the saved balance reading on the staff company page.
- **Phase 3, money out:** paying out of the account with a signed message, Expendi's fee float, USDC payouts to a payee on NEAR, Base and Solana, withdrawals, the Base hop and the sweep, Move to Treasury and Move to wallet, and the staff hand-back of a payout.
- **Phase 4, what people see:** the staff pages (company page, NEAR Intents quote page, alert label) are in the working tree. Receipts, exports, wallet history and the withdrawal screens are not: at this writing the working tree changes none of `invoice-pdf.ts`, `bills/payment-receipt.ts`, `export/data.ts`, `wallet/history.ts` or `withdrawal/withdrawals.ts`. Check `git status` before running C21 and record what the build you test does.

**What was measured on mainnet, and what was not.** Measured on 2026-11-13 (the list is in `docs/decisions/confidential-accounts.md`, "What was proved"): sign-in, a move-in of 0.3 USDC, a payout to Base, a payout to NEAR, an exact-amount-out hop of 0.1 USDC to Base with its unused buffer coming back, and a set of dry quotes. Everything else in this plan was tested only against fakes. This plan is the first time the code runs against 1Click for real. Two behaviours were never measured: a refund on the confidential route, and a payout to a NEAR account that isn't registered for USDC.

**Read first:** `docs/work/confidential-accounts/phase-2-design.md`, `docs/work/confidential-accounts/phase-3-4-design.md` and `docs/runbooks/confidential-accounts.md`. Terms are in `CONTEXT.md`.

> **Money:** every live check moves real USDC on mainnet, because NEAR Intents has no testnet. Plan about 30 USDC in the company, of which 10 USDC goes into Treasury and comes back, and about 12 USDC goes to the payees and cash-outs. Costs are cents: about 0.0048 USDC fixed plus 2 bps for a payout to Base (measured), more for Solana (a dry quote read 0.989765 per 1 USDC), and the fee float is Expendi's money, not the company's.

---

## 1. Before you start

### Owner to-dos

| #   | What                                                                                                                                                                                                                                                                                                                       | Who             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| P1  | Take a baseline of Expendi Demo Co **before** the release for C22: one payout of a few KES and one fund-in, with their ledger rows, audit entries and receipts saved. The company is still a public one at this point                                                                                                      | Dennis + Claude |
| P2  | The read-only check of existing rows (below), on staging and on dev, before any migration runs. All counts must be 0                                                                                                                                                                                                       | Claude          |
| P3  | Release the branch to `staging` (or deploy it to the Railway `staging` API) so migrations 0102 to 0105 run. Migration 0102 re-checks every existing `wallet_transactions` row                                                                                                                                              | Dennis          |
| P4  | `ONECLICK_API_KEY` (the partner key) is set in Doppler `stg`                                                                                                                                                                                                                                                               | Dennis          |
| P5  | `CONFIDENTIAL_ACCOUNT_DEMO_ORGANIZATION_ID` is set in Doppler `stg` to Expendi Demo Co's organization ID, then the API is redeployed                                                                                                                                                                                       | Dennis          |
| P6  | **Hold back** the gas relayer's USDC until C3 is done. It held 0.47 USDC on 2026-11-13, less than the 1 USDC of the first float refill, which is what C3 needs. Then fund it with at least 2 USDC (1 for the first refill, 1 for room)                                                                                     | Dennis          |
| P7  | A Railway tunnel to the staging database: `npx -y @railway/cli@5.71.0 connect Postgres -e staging --tunnel-only -P 55433`                                                                                                                                                                                                  | Dennis          |
| P8  | At least 20 USDC on NEAR in the company wallet before C1, so the move-in has something to move. Expendi Demo Co's ledger read 11.574034 USDC on 2026-11-13 after the Treasury QA; add what is missing                                                                                                                      | Dennis          |
| P9  | An external wallet with USDC on Base and another with USDC on NEAR (not the company's), for C4 and C6. A second NEAR account with USDC registered, and one implicit NEAR account that never held USDC, as payees for C8. An M-Pesa number you hold, for C13 and C14. A payee on Base and a payee on Solana, as USDC payees | Dennis          |
| P10 | Staging's cash-out provider is Paycrest at the start (Controls, Cash-out provider), with Pretium ready to switch to for C14. See `docs/runbooks/pretium-cash-out-qa.md`                                                                                                                                                    | Dennis          |

### The read-only check of existing rows (P2)

`phase-2-design.md` asks for this before migration 0102 runs, because 0102 replaces three checks on `wallet_transactions` and re-checks every existing row. Run each query over the tunnel with a read-only role. Every count must be 0.

```sql
-- Rows the new deposit rule would reject: a quote-linked deposit, or a deposit missing a chain field
SELECT count(*) FROM wallet_transactions
WHERE type = 'deposit'
  AND (intent_quote_id IS NOT NULL OR tx_hash IS NULL OR log_index IS NULL OR block_number IS NULL);

-- Rows the new unique index on a quote's settlement credit would reject
SELECT intent_quote_id, count(*) FROM wallet_transactions
WHERE intent_quote_id IS NOT NULL AND tx_hash IS NULL AND usdc_amount > 0
GROUP BY intent_quote_id HAVING count(*) > 1;

-- Rows the tightened quote checks of migration 0104 assume do not exist
SELECT count(*) FROM intent_quotes
WHERE deposit_type = 'CONFIDENTIAL_INTENTS' OR refund_type = 'CONFIDENTIAL_INTENTS'
   OR signed_intent IS NOT NULL OR ledger_credited_at IS NOT NULL;
```

The first query is the one the design names. The second and third are derived from the SQL of migrations 0102 and 0104. Record the counts in section 5.

### The drivers

There is no screen that turns a company on, and no staff route does. Two scripts stand in:

- `apps/api/scripts/confidential-account.ts` turns a company on or off. It prints the company's name and the database host, and refuses unless the staging variable, the exact company name, `--yes` and an empty in-flight list all hold. It never moves money: the move-in job does.
- `apps/api/scripts/treasury-qa.ts reconcile` prints the ledger against the company wallet, the transit wallet and the confidential account, with Expendi's recorded surplus and a warning while money is in flight. Other commands of this driver are described in `docs/work/treasury/qa-plan.md`.

Run either with the staging secrets and the tunnel:

```
DATABASE_URL=postgres://…@localhost:55433/… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/<script>.ts <command> --organization-id <id> …
```

Payouts, bills, withdrawals, fund-ins and pay links are done through the web dashboard at `https://staging.business.expendi.app`, signed in as the company's admin, because every money action needs the browser's passkey. Staff pages are in the staff app on staging.

---

## 2. Automated checks (the gate before any live check)

Run on a fresh database. All must pass.

```
cd apps/api
TEST_DATABASE_URL=… TEST_DATABASE_URL_MIGRATE=… pnpm exec vitest run
TEST_DATABASE_URL=… TEST_DATABASE_URL_MIGRATE=… pnpm exec vitest run --config vitest.serial.config.ts
pnpm turbo run typecheck lint format
pnpm --filter @expendi-business/api db:generate   # must say "No schema changes"
```

The suites below are the evidence for what the live checks can't reach. All run against fakes: `makeFakeOneClick` fakes `generateIntent`, `submitIntent`, sessions and balances. The "what the tests prove" column is what the design assigned to each suite; the suites were not re-read for this page, so confirm a row against the file before relying on it.

| Area                | What the tests prove                                                                                                                            | Where                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Message checks      | A message is signed only for exactly the quote's amount in; non-canonical text, a repeated key, a wrong token or receiver is refused            | `services/confidential-account.test.ts`                                                |
| Signing a quote     | Save before submit; a retry submits the same bytes; one signer at a time; `failed` only with nothing signed or past the message's deadline      | `services/quote-intent.serial.test.ts`, `db/confidential-accounts.test.ts`             |
| Move-in             | Only for a confidential company; amount; parts under the cap; one at a time; rests 30 minutes after a refund; blocked by a quote in review      | `services/move-ins.serial.test.ts`                                                     |
| Settlement credit   | Credited once from `swappedAmountOut`; an unusable amount is not credited; a Move to wallet return is credited as `from_treasury`               | `services/quote-credit.serial.test.ts`                                                 |
| Fee float           | The float formula, the refill, the relayer being short, one refill at a time                                                                    | `services/fee-covers.serial.test.ts`, `services/intent-surplus.test.ts`                |
| Reconcile and alert | Each in-flight reason keeps the alert; a negative difference fires; excess in the account fires; excess waiting in the company wallet does not  | `services/confidential-alerts.serial.test.ts`                                          |
| Opening quotes      | Request fields and sessions for a confidential company; a public company's request bytes are unchanged                                          | `services/open-company-quote.test.ts`, `routes/pay.test.ts`, `routes/fund-ins.test.ts` |
| Staff               | No live call to 1Click for a confidential quote; a payout is handed back only after the job settled the quote; no staff code can sign or submit | `routes/internal-intent-quotes.serial.test.ts`, `routes/internal-routes.test.ts`       |
| The script          | Every guard                                                                                                                                     | `scripts/confidential-account.test.ts`                                                 |
| Signing boundary    | Only three modules may ask Privy for a NEAR signer                                                                                              | `near-signing-boundary.test.ts`                                                        |

---

## 3. Live checks on staging

Use Expendi Demo Co only: the script refuses any other company. For every check record the quote ID, the seconds it took, the balances before and after (`reconcile`), and the reconcile difference. NEAR explorer: `https://nearblocks.io/txns/<hash>`. Base explorer: `https://basescan.org/tx/<hash>`.

"Public view" says what a person looking at the public explorers can and cannot see. Only the six NEAR transactions of the 2026-11-13 spike are measured (none names the company account). Every other line is what the design expects: confirm it, and write down what you see instead if it differs.

After each check wait for the alerts job's next run, then confirm the alert `confidential_balance_mismatch` is not open for the company.

### Turning on and money in

- [ ] **C1. Turn on.** Run `turn-on` with `--organization-id`, `--company-name` and `--yes`.
  - Expect: it prints `Balance home: confidential_account`, the confidential account's balance (0 at first) and the line about the move-in job. The audit log has `wallet.balance_home_changed` with actor `confidential-account-script`.
  - Also check each refusal, one run each, nothing changes: without `--yes`; with a wrong `--company-name`; with the demo variable unset in the shell (guard 1); a second `turn-on` ("already confidential_account").
  - Record: the printed balance, the guard messages.
  - Public view: nothing. Only the database changed.
- [ ] **C2. Move-in of the existing balance** (after C1, with P8's USDC in the company wallet). Within a few 30-second runs of the move-in job.
  - Expect: one `move_in` quote (purpose `move_in`, recipient type `CONFIDENTIAL_INTENTS`, `amountIn` equal to `amountOut`), or several if the balance is above the company's per-transaction maximum, each one after the last. The company wallet falls to Expendi's surplus plus dust. The confidential account rises by the same amount (measured 0.3 USDC in 20 seconds on 2026-11-13). **No ledger row is written** and the ledger balance is unchanged. Audit `move_in.created`.
  - Check the company page in the staff app: `Confidential account, as of <time>: <amount>` after the alerts job's next run.
  - Record: quote IDs, seconds, the surplus left in the company wallet, the relayer's NEAR spent (one storage registration per move-in).
  - Public view: the company wallet's transfer of USDC to a 1Click deposit address is a public NEAR transaction. Expect it to show the company wallet as the sender and the amount. The wallet's balance then reads about 0. Later payments out of the account are not shown against it.
- [ ] **C3. Fee float, with the relayer still short** (P6 held back). Run this before funding the relayer.
  - Expect: no refill starts. The API log on Railway says `[fee-cover] the gas relayer holds less USDC than the 1000000 units … float needs; nothing topped up` (the amount is the refill: 1 USDC for a new company). `reconcile` shows Expendi's recorded surplus without a float. A payout to a NEAR payee still works (C8), and a payout to Base waits then fails with "nothing was sent" (C9, run it once now to see it).
  - Then fund the relayer (P6) and expect, within a minute: one `fee_cover` quote of 1 USDC, recipient type `CONFIDENTIAL_INTENTS`, refund to the relayer, ending `succeeded`; the relayer's USDC falls by 1; the confidential account holds 1 USDC more; `reconcile` reports Expendi's recorded surplus about 1 USDC higher, and the difference matches it.
  - Record: the relayer's USDC and NEAR before and after, the quote ID, the time, and the log line.
  - Public view: the relayer's USDC transfer to a deposit address is public and shows the relayer and the amount. Whether it names the company's account: record what you see.
- [ ] **C4. A fund-in from Base** (at least 0.15 USDC; use 1 USDC from P9's Base wallet) through the dashboard.
  - Expect: no transfer reaches the company wallet. When 1Click reports `SUCCESS`, within one run of the fund-ins job (30 seconds), one ledger row: type `deposit`, chain `near`, amount = what 1Click says it delivered, no transaction hash, linked to the quote. Audit `wallet.deposit_received` with source `one_click_success`. The confidential account rises by the same amount (measured for the NEAR leg, 20 seconds; Base is dry-quoted at 35 seconds, 0.999798 per 1 USDC).
  - Record: quote ID, delivered amount, seconds, ledger row.
  - Public view: the sender's transfer on Base is public. The credit into the account is not visible on any chain.
- [ ] **C5. An invoice payment through the pay link.** Create an invoice, open the pay link in a private window, pay it from Base.
  - Expect: the invoice is marked paid in the same transaction as the ledger credit. The receipt email arrives with no "Transaction:" line. The invoice payment shows with no transaction hash in the dashboard and in the PDF.
  - Record: quote ID, the email, the PDF.
  - Public view: as C4.
- [ ] **C6. A plain USDC transfer to the company wallet**, from P9's NEAR wallet, 2 USDC.
  - Expect: the deposit watcher credits it from the transfer as today (a `deposit` row with a hash). Then the move-in job moves it into the account (a second move-in, no ledger row). The ledger counts it once.
  - Record: both transaction hashes, the time between them, `reconcile`.
  - Public view: the transfer into the company wallet is public. Then the move-in's transfer, as C2.

### Money out

- [ ] **C7. Two payouts at once against a tight balance.** Approve two USDC payouts to Base whose total is more than the account holds, each less than it holds on its own.
  - Expect: the first quote is paid; the second waits (the account must hold its amount plus the amounts of the wallet's other quotes in flight) and expires with its payout failed "nothing was sent" if it never gets its turn. A retry after the first settles works.
  - Record: both quote IDs, which waited, and for how long.
- [ ] **C8. A USDC payout to a payee on NEAR.** Three payees: a named account registered for USDC, an implicit account that never held USDC, and a named account that is not registered for USDC.
  - Expect for the first two: one `usdc_payout` quote, `EXACT_INPUT`, `amountOut` equal to `amountIn`, cost 0 (measured: 0.2 USDC in, 0.2 delivered, 13 seconds, no fee). The payout is `paid` and debited in one transaction: a `payout` ledger row, chain `near`, no hash, for exactly the approved USDC. The payout's reference is 1Click's delivery transaction. The float is unchanged.
  - Expect for the third, which was never measured: the payout fails before anything is signed, with the message for an account that can't receive USDC. Nothing is sent. If it doesn't fail, stop and record exactly what happened.
  - Record: each quote, the ledger row, the failure text.
  - Public view: the payee's receipt from 1Click's shared NEAR Intents account is public (amount and the payee's address). Nothing names the company account (measured for the NEAR payout leg).
- [ ] **C9. A USDC payout to a payee on Base.** 1 USDC.
  - Expect: an `EXACT_OUTPUT` quote of 1.000000 out. Measured cost about 0.0048 USDC fixed plus 2 bps. The payee gets exactly 1 USDC. `paid` and debited for exactly the approved USDC, the cost coming out of the float. The unused buffer returns to the account about a minute after `SUCCESS` (measured on 2026-11-13: 23 seconds to deliver, 1059 units back about a minute later, not reported as a refund). `reconcile` stays steady: the float is lower by the cost and the buffer returns.
  - Record: quote, amount in, amount delivered, seconds, float before and after, the time the buffer came back.
  - Public view: the payee's receipt on Base. Nothing names the company account.
- [ ] **C10. A USDC payout to a payee on Solana.** 1 USDC.
  - Expect: only a dry quote exists (0.989765 per 1 USDC, 7 seconds), so this is the first real run. The payee gets exactly 1 USDC. `paid` and debited, the cost taken from the float. Staff can't read Solana: the quote page lists 1Click's destination transaction, with no check of it.
  - Record: quote, cost, seconds, the Solana transaction.
  - Public view: the payee's receipt on Solana. Nothing names the company account.
- [ ] **C11. A withdrawal** to an allowlisted address, once on NEAR and once on Base.
  - Expect: the same path as a payout, with a `withdrawal` ledger row, no hash, and the payout's reference as the destination transaction.
  - Record: quote, ledger row, and what the withdrawal screen shows for the transaction.
- [ ] **C12. A payout approved while its USDC is still in the public wallet.** Pause the company's payouts, send 2 USDC to the company wallet, wait for the ledger credit, unpause and approve a payout at once, before the move-in job runs.
  - Expect: the ledger shows the money but the account doesn't hold it yet, so the quote waits until the move-in has run, and is paid after. If the timing is missed (the job is 30 seconds), record "not produced".
- [ ] **C13. A cash-out through Paycrest**, with Paycrest active. KES 100 to an M-Pesa number you hold.
  - Expect: a `base_hop` quote paid out of the account (`EXACT_OUTPUT`, recipient the transit wallet, refund into the account). The phone receives exactly KES 100. The hop writes no ledger row. The debit is the transit wallet's send on Base, as for a public company. The buffer returns to the account.
  - Record: hop quote, transit wallet hash, M-Pesa receipt, time of each step, float before and after.
  - Public view: the transit wallet's activity on Base is public.
- [ ] **C14. A cash-out through Pretium, including a payroll run.** Switch the cash-out provider to Pretium (Controls, per `docs/runbooks/pretium-cash-out-qa.md`). Pay KES 100 to M-Pesa, then run payroll for two people (KES 60 and KES 80).
  - Expect: one Base hop for the payroll's total, two Pretium transactions, both paid. Switch back to Paycrest afterwards.
  - Record: quotes, Pretium transaction codes, receipts.
- [ ] **C15. The sweep.** After a hop that leaves more than 1 USDC in the transit wallet with nothing in flight (a Paycrest or Pretium refund, or a hop whose cash-out never funded), the sweep job (every 5 minutes) returns it.
  - Expect: a `sweep` quote delivered into the confidential account, refund to the transit wallet. Not a ledger entry. The cost (a dry quote read 0.999798 per 1 USDC) comes out of the float.
  - If no cash-out refunds, record "not produced". Do not send USDC to the transit wallet to force it: the deposit watcher flags unexpected USDC there.
- [ ] **C16. Move to Treasury and Move to wallet**, 10 USDC (the least a move to Treasury takes), through the dashboard.
  - Move to Treasury expect: a `to_treasury` quote paid out of the account, no fee cover (the company pays the charge). On `SUCCESS` one `to_treasury` ledger row of the amount in, with no hash, then the vault deposit of what 1Click delivered. The Treasury wallet holds no USDC afterwards. A refunded part writes the debit and a `from_treasury` credit of the refunded amount in one transaction.
  - Move to wallet expect: a Base to NEAR quote delivered into the account, credited at settlement as `from_treasury` (linked to the move and the quote, no hash, audit `wallet.treasury_returned`) within one run of the fund-ins job. The move completes when the credits reach what 1Click delivered. All 10 USDC comes back less 1Click's costs, as in `docs/work/treasury/qa-plan.md` L17.
  - Record: both moves' IDs, quotes, ledger rows, time, cost.
  - Public view: the Treasury wallet on Base is public: the amount, the vault deposit and the withdrawal. The NEAR legs name the shared account.
- [ ] **C17. Fee float refills.** The float starts at 1 USDC (C3) and is spent only by costs of a few cents. It can't be driven under the 0.25 USDC low-water mark with staging-sized payments, so no second refill is expected. Record the float after every check from `reconcile`, and the total spent by the end. If it ever falls below 0.25 USDC, expect one refill within two 30-second runs.

### Safety and state

- [ ] **C18. Turn off is refused while it holds money.** After C2, run `turn-off`.
  - Expect: the refusal "The company's confidential account still holds <x> USDC. Moving a balance back out of a confidential account isn't built yet, so a company that is turned on stays on until it is". The flag does not change. There is no way to move the balance back out: do not look for one. QA money leaves the account by payouts, Treasury and withdrawals.
- [ ] **C19. The reconcile and the alert stay quiet.** After every check above, and at the end with nothing in flight, run `reconcile`.
  - Expect: with nothing in flight, the difference equals "Expendi's recorded surplus": the float plus whatever a hop left in the company wallet. The alert is not open. While a check is running, the reconcile warns, and the alert stays as it is.
  - None of the three alert reasons in the runbook (short, unexplained, delivered but not credited) can be raised without making the balance wrong, so they are covered by tests only.
- [ ] **C20. Restart between the save and the submit.** Approve a payout to Base and restart the staging API service on Railway right after the quote shows a saved signed message and no message hash. The window is short.
  - Expect: after it comes back, the quote submits the same saved bytes, and the payout is paid once. If the window is missed, record "not produced".
- [ ] **C21. Receipts, exports and staff pages.** For each place below, record what is shown for a confidential payout and for a confidential invoice payment, and look for any error on a null transaction hash.
  - Invoice receipt email and invoice PDF: no transaction line for a credit with no hash (built in Phase 2).
  - Bill payment receipt PDF, wallet history, the withdrawal screen, the CSV export, the Treasury export: no change is in the working tree at this writing. Expect no transaction shown for a payout, and no error. A cash-out's receipt still names the Base funding transaction. Compare each to `phase-3-4-design.md` D1 and list the gaps.
  - Staff company page: `Confidential account, as of <time>: <amount>`, matching `reconcile`.
  - NEAR Intents quote page: "Paid by: A signed message out of the company's confidential account", the message hash, deadline and submitted time, the last 1Click status, and no signed message.
  - Alerts page: the kind label reads "Confidential balance mismatch" if one opened.
- [ ] **C22. A public company is unchanged.** After the release, repeat P1's payout and fund-in for a company that is not confidential, and compare field by field with the baseline: request bytes, ledger rows, audit entries, receipts.
  - Expect: no difference.

### Not forced live (automated only, or not producible on staging)

These can't be done on demand, or would risk money, so the automated tests are the only evidence. Do not mark them done from a live run.

- **A refund on the confidential route.** Where it lands, whether `refundedAmount` is the whole payment, and how long it takes were never measured. Try one cheap way: a fund-in of less than the 0.15 USDC minimum, which may be refunded into the company's public NEAR Intents account and then returned into the account by the fund-in return job. It is not known that 1Click refunds a deposit that small. A refunded payout, hop or Move to Treasury part can't be produced on demand.
- **1Click reporting `FAILED`.** Only 1Click can cause it, and NEAR Intents support has to resolve it.
- **The message's own three-day deadline passing.** The `failed` rule for a signed message needs three days and 1Click still seeing no deposit.
- **A quote in `needs_review` and the staff hand-back of a payout.** It needs a quote that is stuck. Tested in `routes/internal-intent-quotes.serial.test.ts`, including that staff code signs and sends nothing.
- **A second fee float refill.** See C17.
- **Privy not saying whether it signed, and a refused or timed-out submit.** Whether `submit-intent` is safe to repeat with the same bytes is assumed from the design, not measured.
- **1Click, Privy or the NEAR RPC being down.** Not caused on purpose on staging.
- **Turning a company off with a balance.** Not built.
- **The account's history.** `GET /v0/account/history` is invite-only.
- **Rate limits at scale.** A payroll of 50 USDC payees is about 150 extra 1Click calls plus status reads. Not measured.
- **Production.** The script refuses any company but the staging demo company. Nothing here is a production check.

---

## 4. Hygiene

- [ ] Typecheck, lint, format and `db:generate` clean (section 2)
- [ ] No keys, signed messages or passkey files committed
- [ ] No `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] The test company's payouts unpaused after C12, and its cash-out provider back on Paycrest after C14
- [ ] No QA payee, bill or invoice left open
- [ ] The relayer's USDC and NEAR recorded before and after
- [ ] Every live result recorded in section 5

---

## 5. Results

**Owner steps done:**

- **P1:**
- **P2** (counts of the three queries, on staging and on dev):
- **P3:**

| Check     | Date | Result | Evidence (quote IDs, hashes, seconds, balances, reconcile difference) |
| --------- | ---- | ------ | --------------------------------------------------------------------- |
| Automated |      |        |                                                                       |
| C1        |      |        |                                                                       |
| C2        |      |        |                                                                       |
| C3        |      |        |                                                                       |
| C4        |      |        |                                                                       |
| C5        |      |        |                                                                       |
| C6        |      |        |                                                                       |
| C7        |      |        |                                                                       |
| C8        |      |        |                                                                       |
| C9        |      |        |                                                                       |
| C10       |      |        |                                                                       |
| C11       |      |        |                                                                       |
| C12       |      |        |                                                                       |
| C13       |      |        |                                                                       |
| C14       |      |        |                                                                       |
| C15       |      |        |                                                                       |
| C16       |      |        |                                                                       |
| C17       |      |        |                                                                       |
| C18       |      |        |                                                                       |
| C19       |      |        |                                                                       |
| C20       |      |        |                                                                       |
| C21       |      |        |                                                                       |
| C22       |      |        |                                                                       |

**Where the QA money ends up:** in the company's confidential account, less the costs of each payout, Treasury move and cash-out. It cannot be moved back out of the account. Spend it on later QA, or leave it.
