# Treasury QA plan: T1 to T7

**Status:** draft, 2026-11-13. Nothing in this plan has been run on staging yet.

**Covers:** what is built on `feat/treasury`:

- **T1:** turning Treasury on, which creates the company's Treasury wallet.
- **T2:** the ledger entries, the `treasury_moves` table, holding back money on its way to Treasury, and crediting money that comes back.
- **T3:** moving money from the company wallet into the vault.
- **T4:** moving money from the vault back to the company wallet, an amount or all of it.
- **T5:** Treasury's value, yield and rate, the daily snapshots, the four staff alerts, and the "Move to wallet" offer when a payment is short.

- **T6 (web):** Treasury on the web dashboard's Accounts page, the move sheets, history, and the "Move to wallet" offer on payment pages.
- **T7:** the monthly export's Treasury sheets, Treasury on the staff app's company page, and the two staff approvals (return a stranded deposit, finish a return to the wallet) that the job carries out.

**Doesn't cover yet:** the mobile app's Treasury screens, which wait for the K1 redesign to reach `staging`.

**Read first:** `docs/work/treasury/spec.md` (sections 4, 5, 6 and 11) and `docs/decisions/treasury-on-base.md`. Terms are in `CONTEXT.md`.

> **Money:** about 40 USDC goes in during QA. L17 moves all of it back to the company wallet at the end, less 1Click's costs (a few cents a part). Only L22, which is optional, leaves 1.1 USDC stranded in the Treasury wallet.

---

## 1. Before you start

### Owner to-dos

| #   | What                                                                                                                                                                                                                                                                                          | Who             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| P1  | Merge `feat/treasury` into `staging` (or deploy the branch to the Railway `staging` API) so migrations 0092 to 0099 run                                                                                                                                                                       | Dennis          |
| P2  | Leave `PRIVY_EARN_VAULT_ID` **unset** in Doppler `stg` until check L1 is done, then set it to `ry2qt6co7rkpwkr5mqudloo4`                                                                                                                                                                      | Dennis          |
| P3  | A test company on staging with an active NEAR company wallet, admin A, admin B, an accountant and an employee. **Admin A is a dedicated QA account, not a real person's, with no passkey yet:** the driver enrols its own passkey for it, and `enrol` refuses an account that already has one | Dennis + Claude |
| P4  | About 40 USDC on NEAR in that company wallet, sent as a fund-in                                                                                                                                                                                                                               | Dennis          |
| P5  | A Railway tunnel to the staging database: `npx -y @railway/cli@5.71.0 connect Postgres -e staging --tunnel-only -P 55433`                                                                                                                                                                     | Dennis          |
| P6  | Admin A signed in to the mobile app on a test phone, so its pushes arrive; admin A's and admin B's inboxes readable                                                                                                                                                                           | Dennis          |
| P7  | A bill in the test company, to a payee paid in KES, for more than the company wallet will hold during L21                                                                                                                                                                                     | Dennis + Claude |

### The QA driver

There is no Treasury screen yet, and every money action needs a passkey. As `scripts/test-payout.ts` did for payouts, `apps/api/scripts/treasury-qa.ts` stands in for the app. It calls the same services the routes call, with a software passkey kept owner-only under `apps/api/.cache/treasury-qa/`, which git ignores. It never runs the move job itself: the deployed staging job does that.

Every command takes `--organization-id <id>`. The ones that confirm also take `--admin-email <admin A>`. Every command first prints the company's name and the database host.

| Command                                                                 | What it does                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `enrol`                                                                 | Enrols the software passkey for admin A                                                                        |
| `status`                                                                | Same as `GET /treasury`: status, address, value, yield, rate, KES, open move, when it was read                 |
| `turn-on`                                                               | Passkey confirmation, then turns Treasury on                                                                   |
| `preview --direction to_treasury\|to_wallet (--usdc <amount> \| --all)` | Same as `POST /treasury/moves/preview`                                                                         |
| `move --direction … (--usdc … \| --all) --yes`                          | Passkey confirmation, then starts the move. Refuses without `--yes`                                            |
| `moves`                                                                 | The move history                                                                                               |
| `inspect --move-id <id>`                                                | The move, its quotes, its Earn calls, its ledger rows and the vault position, with explorer links              |
| `reconcile`                                                             | The ledger against what the company wallet and transit wallet hold on chain; warns while anything is in flight |
| `alerts`                                                                | The company's open Treasury alerts                                                                             |
| `return-stranded --move-id <id> --yes`                                  | Sends a stranded deposit back (a move to Treasury in review). Not used unless something goes wrong             |

Run it with the staging secrets and the tunnel:

```
DATABASE_URL=postgres://…@localhost:55433/… doppler run -p expendi-business -c stg -- \
  pnpm --filter @expendi-business/api exec tsx scripts/treasury-qa.ts <command> …
```

The role checks (L3) are route checks, so they run against the staging API with each person's own sign-in.

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

| Feature | What the tests prove                                                                                                      | Where                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T1      | Turning on twice makes one wallet, one audit entry and one email                                                          | `routes/treasury.test.ts`                                            |
| T1      | A wallet with the wrong owner, policy or signer is refused, and nothing is marked on                                      | `routes/treasury.test.ts`                                            |
| T1      | Unavailable while the vault ID is unset; refused for a Base or not-yet-active company wallet                              | `routes/treasury.test.ts`                                            |
| T1      | The policy is exactly: Earn into one vault, Earn out of it, the capped USDC transfer                                      | `services/wallet-policy.test.ts`                                     |
| T2      | Each entry type has the right sign and its move; one debit per quote; no deletes                                          | `db/treasury-ledger.test.ts`                                         |
| T2      | A payout, bill, claim, float or withdrawal can't spend money reserved for an open move                                    | `services/treasury-reservation.test.ts`                              |
| T2      | Money back from Treasury is credited once; an ordinary hop refund or sweep is still skipped                               | `services/treasury-reservation.test.ts`                              |
| T3      | A move over the cap goes in parts, one at a time, each within the cap                                                     | `services/treasury-moves.test.ts`                                    |
| T3      | Every row of spec section 11 for this direction                                                                           | `services/treasury-moves.test.ts`                                    |
| T3      | Running each step twice, or after a crash, never sends or deposits twice                                                  | `services/treasury-moves.test.ts`                                    |
| T3      | Only what the quote delivered is deposited, never the Treasury wallet's whole balance                                     | `services/treasury-moves.test.ts`                                    |
| T3      | A refunded part is credited back through the real deposit watcher                                                         | `services/treasury-moves.serial.test.ts`                             |
| T3, T4  | Preview, confirm and start; roles; 409 for a second open move or more than Treasury holds                                 | `routes/treasury-moves.test.ts`                                      |
| T3      | Privy Earn calls and how their failures are read                                                                          | `services/privy-earn.test.ts`                                        |
| T4      | Full, "all" and partly filled withdrawals; only what the withdrawal's own transaction delivered is sent back              | `services/treasury-to-wallet.test.ts`                                |
| T4      | USDC someone else sent to the Treasury wallet is never sent back or credited                                              | `services/treasury-to-wallet.test.ts`                                |
| T4      | A refunded return part is retried after 30 minutes and never overpays; each step run twice never withdraws or sends twice | `services/treasury-to-wallet.test.ts`                                |
| T4      | Each delivery is credited once by the real deposit watcher                                                                | `services/treasury-to-wallet.serial.test.ts`                         |
| T5      | Value, yield after moves both ways, rate, KES; the last snapshot when Privy is down                                       | `services/treasury-figures.test.ts`                                  |
| T5      | One snapshot per company per Nairobi day                                                                                  | `services/treasury-snapshots.serial.test.ts`                         |
| T5      | Each alert opens once, stays quiet inside Privy's lag window, and resolves                                                | `services/treasury-alerts.serial.test.ts`                            |
| T5      | A short payment offers "Move to wallet" only when Treasury holds money                                                    | `routes/short-wallet.test.ts`                                        |
| Driver  | Every driver command against the test database                                                                            | `scripts/treasury-qa.test.ts`                                        |
| All     | Accountants can't change anything; no staff route reaches a money path                                                    | `routes/accountant-access.test.ts`, `routes/internal-routes.test.ts` |

---

## 3. Live checks on staging

Record every result in section 5, with the transaction hashes. Base explorer: `https://basescan.org/tx/<hash>`. NEAR explorer: `https://nearblocks.io/txns/<hash>`.

### T1: turning Treasury on

- [ ] **L1. Unavailable without a vault.** With `PRIVY_EARN_VAULT_ID` unset, `status` shows `unavailable` and `turn-on` is refused. Then set the secret (P2) and redeploy.
- [ ] **L2. Off before it's turned on.** `status` shows `off`.
- [ ] **L3. Who can do what**, against the staging API with each person signed in:
  - accountant: `GET /treasury` and `GET /treasury/moves` work; `POST /treasury/confirmations` and `POST /treasury/moves/confirmations` give 403
  - employee: every Treasury route gives 403
- [ ] **L4. Turn on.** `enrol`, then `turn-on` as admin A, shows `on` and an address. Then check:
  - in the Privy dashboard: a wallet with external ID `treasury-<organisation ID>`, owned by the management quorum, with the runtime signer as its only additional signer and one policy with three rules
  - the audit log has `treasury.turned_on`
  - admins A and B each got the email
- [ ] **L5. Turn on again.** Still one Treasury wallet in Privy, no second audit entry, no second email.

### T3 and T2: moving money to Treasury

- [ ] **L6. Preview.** `preview --direction to_treasury --usdc 10` shows 1 part, a cost under 0.05 USDC, an estimated time, and what's available. Nothing is saved: `moves` is unchanged.
- [ ] **L7. Refusals, each with nothing saved:**
  - `preview … --usdc 9.99`: "The least you can move to Treasury is 10 USDC."
  - `preview` for more than what's available: refused
  - with the company's payouts paused from the staff app: `move` refused with "Payouts are paused…". Unpause afterwards.
- [ ] **L8. First real move, 10 USDC.** `move --direction to_treasury --usdc 10 --yes`, then `inspect` every 15 seconds until it ends. Expect, in order:
  1. a quote, recipient the Treasury wallet, refund to the company wallet
  2. the company wallet's send on NEAR
  3. one `to_treasury` ledger row of -10 USDC
  4. 1Click reports the delivery to the Treasury wallet on Base
  5. one Earn deposit, of exactly what 1Click delivered, `succeeded`
  6. the move `completed`, with `moved_usdc` and `cost_usdc` filled in

  Then check:
  - admin A got a push saying it's done
  - the audit log has `treasury_move.started` and `treasury_move.completed`
  - the vault position's `assets_in_vault` is about `moved_usdc`
  - the Treasury wallet holds no USDC and no ETH afterwards
  - the end-to-end time, for the spec's estimate (about 30 seconds a part)

  This is also the first real proof of the NEAR to Base route for Treasury (spec section 12, item 9, first half).

- [ ] **L9. Money in a move can't be spent.** Start a 10 USDC move. Before it completes, try to withdraw the whole wallet balance to an allowlisted address: refused, because it is more than what's available. Let the move finish.
- [ ] **L10. One move at a time.** While L9's move is open, a second `move` is refused with 409 and nothing is saved.
- [ ] **L11. A move in parts.** In the staging database, set the test company's `wallets.per_transaction_max_usdc` to `6000000` (6 USDC). Move 10 USDC. Expect 2 parts, one after the other, each with its own quote, debit and Earn deposit, and the move `completed`. Leave the cap at 6 USDC for L16.
- [ ] **L12. Restart in the middle.** Start a 10 USDC move and restart the staging API service on Railway right after the send appears. After it comes back, the move completes, with exactly one send, one `to_treasury` row and one successful Earn deposit per part.
- [ ] **L13. History.** `GET /wallet/history` shows each part as "Moved to Treasury" with the amount that left. Check it in the web dashboard's wallet history too.

### T5: what admins and staff see

- [ ] **L14. Figures.** `status` shows the value close to the sum of `moved_usdc` so far, a rate close to the vault's (about 5% a year when this plan was written), a yield of zero or a few cents, the KES equivalent and `saved: false`. The accountant gets the same from `GET /treasury`.
- [ ] **L15. The daily snapshot.** The day after L8, the staging database has one `treasury_snapshots` row for the company for that Nairobi day, and no second one later that day.

### T4: moving money back to the wallet

- [ ] **L16. Move 10 USDC back, in parts.** With the cap still at 6 USDC from L11, `preview --direction to_wallet --usdc 10`, then `move --direction to_wallet --usdc 10 --yes`. `inspect` until it ends. Expect:
  1. one Earn withdrawal `succeeded`, and `delivered_usdc` equal to the USDC its transaction moved to the Treasury wallet (check the bundle transaction on Basescan)
  2. 2 return parts, one after the other, each a quote paid by the Treasury wallet
  3. a `from_treasury` ledger row for each delivery, credited once
  4. the move `completed`, `moved_usdc` about 10 USDC less 1Click's costs

  Put the cap back to `3100000000` afterwards.

  This is the first real proof of the Base to NEAR route for Treasury (spec section 12, item 9, second half).

- [ ] **L17. Move everything back.** `move --direction to_wallet --all --yes`. The move completes; `status` shows a value of at most a few base units; the Treasury wallet holds no USDC. All the QA money is back in the company wallet.
- [ ] **L18. Refusals:** `preview --direction to_wallet` for more than Treasury holds is refused; a second move while one is open is refused with 409.
- [ ] **L19. History.** `GET /wallet/history` shows each delivery as "Moved to wallet".
- [ ] **L20. The ledger matches the chain.** After L17, `reconcile` shows the ledger balance equal to what the company wallet and transit wallet hold.

### T5: "Move to wallet" and alerts

Do L21 before L17, while Treasury still holds money.

- [ ] **L21. The short-wallet offer.** Pay the bill from P7, which is more than what's available, while Treasury holds money. The refusal is a 409 that says how much is short and how much is in Treasury, and its `details.treasuryOffer` has `action: "move_to_wallet"`. Nothing is sent. With Treasury empty (after L17), the same payment gives the ordinary refusal with no offer.
- [ ] **L22 (optional, strands 1.1 USDC). USDC left in the Treasury wallet.** With no move open, send 1.1 USDC on Base straight to the Treasury wallet. Within about a minute `alerts` shows the "USDC sitting in a Treasury wallet" alert, and the staff app lists it, linking to the company page. That USDC is never credited and needs a person to recover it.

### T6 and T7: the web dashboard, the export and the staff app

Do L23 to L25 on `https://staging.business.expendi.app`, signed in as each person, alongside the driver checks above. One of the moves can be made from the web instead of the driver.

- [ ] **L23. Accounts page, admin.** Before turning on: Treasury invites you to turn it on and shows the current rate. After L4: it shows the value, yield, rate, any open move and the move history, and it matches `status`. Turning on and both move sheets work end to end with the browser's own passkey, including the preview and the API's refusals (try 9.99 USDC).
- [ ] **L24. Accounts page, accountant and employee.** The accountant sees Treasury with no buttons. The employee doesn't see it.
- [ ] **L25. "Move to wallet" on a short payment.** During L21, the Bills page shows the refusal with a "Move to wallet" button that opens the move sheet with the suggested amount filled in.
- [ ] **L26. Staff app.** On the test company's page in the staff app: the Treasury wallet with its Basescan link, the live position, the open Treasury alerts (after L22, if run), and each move from L8 to L17 with its quotes, Earn calls and ledger rows.
- [ ] **L27. Monthly export.** After the month of the QA moves ends, the company's export has a Treasury sheet with opening and closing value, moved in, moved out, yield and cost, and a Treasury moves sheet with one line per move. Its totals agree with `moves` and `inspect`.

### Not forced live (automated only)

These can't be triggered on demand without risking money, so the automated tests are the evidence:

- 1Click refunding a part, either way (credited back, or retried after 30 minutes)
- Privy rejecting a vault deposit three times (move to review; `return-stranded` sends it back)
- A withdrawal that fills only partly (completes for less; the partial-fill alert)
- An Earn call or a send whose outcome stays unclear (repeated with the same key, then review)
- A move stuck for 30 minutes, and Privy's record disagreeing with Expendi's (the other two alerts)
- Privy unreachable (`status` answers from the last snapshot with `saved: true`)
- The two staff approvals, which need a move stuck in review: tested in `treasury-staff-actions.test.ts` and `internal-treasury-actions.test.ts`, including that no staff route sends anything

---

## 4. Hygiene

- [ ] Typecheck, lint, format and `db:generate` clean (section 2)
- [ ] No keys or passkey files committed; the driver's passkey file is under `apps/api/.cache/treasury-qa/`, which git ignores
- [ ] No `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] The test company's cap back at 3,100 USDC after L16, and its payouts unpaused after L7
- [ ] The QA admin's software passkey removed from the account when QA is over
- [ ] Every live result recorded in section 5

---

## 5. Results

**Owner steps done:**

- **P1** (2026-11-13): PR #14 merged into `staging` (`eef8559`). Railway deploy `66685b10` ran the migrations ("migrations applied") and started the `treasury-moves` and `treasury-snapshots` jobs. The web and staff-app mirror pushes are the owner's to run.
- **P2** (2026-11-13): `PRIVY_EARN_VAULT_ID` set in Doppler `stg`, then the API redeployed.

| Check     | Date       | Result                    | Evidence (tx hashes, move IDs, times)                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated | 2026-11-13 | Pass                      | On the merged branch: API main 3,505, serial 461 twice; shared, web, mobile and admin all pass                                                                                                                                                                                                                                                                                                                                                     |
| L1        | 2026-11-13 | Not run live; tests only  | The vault ID was set before the check could run. Covered by `routes/treasury.test.ts` ("unavailable while the vault ID is unset")                                                                                                                                                                                                                                                                                                                  |
| L2        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L3        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L4        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L5        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L6        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L7        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L8        | 2026-11-13 | Partly checked: move done | Expendi Demo Co, move `454958a0`, 10 USDC from the web. Quote `5a5e87e2` (05:58:57 UTC); NEAR send `6kKThMmi…7kDw` and `to_treasury` −10.000000 (06:00:32); 1Click delivered 9.995580 to Base `0xb1022d2f…cd5b`; Earn deposit `0x1ace10d8…6c1a` succeeded (06:01:42); `completed`, cost 0.004420. Took 2 min 55 s, slowed by NEAR RPC failures while the send was confirmed. Push, audit, vault position and empty Treasury wallet not yet checked |
| L9        |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L10       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L11       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L12       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L13       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L14       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L15       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L16       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L17       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L18       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L19       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L20       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L21       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L22       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L23       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L24       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L25       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L26       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| L27       |            |                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Where the QA money ends up:** back in the test company's wallet after L17, less a few cents of 1Click costs per part, and less 1.1 USDC if L22 was run.
