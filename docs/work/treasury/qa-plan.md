# Treasury QA plan: T1, T2 and T3

**Status:** draft, 2026-11-13. Nothing in this plan has been run on staging yet.

**Covers:** what is built on `feat/treasury`:

- **T1:** turning Treasury on, which creates the company's Treasury wallet.
- **T2:** the ledger entries, the `treasury_moves` table, holding back money on its way to Treasury, and crediting money that comes back.
- **T3:** moving money from the company wallet into the vault.

**Doesn't cover** (not built yet): moving money back to the wallet (T4), Treasury's value, yield and rate (T5), any screen (T6), the export and the staff app (T7).

**Read first:** `docs/work/treasury/spec.md` (sections 4, 5, 6 and 11) and `docs/decisions/treasury-on-base.md`. Terms are in `CONTEXT.md`.

> **Money put in during QA stays in Treasury until T4 ships.** Nothing can move it back to the company wallet before then, except a person using the management key. Keep every live amount small: this plan uses about 30 USDC in total.

---

## 1. Before you start

### Owner to-dos

| #   | What                                                                                                                      | Who             |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------- |
| P1  | Merge `feat/treasury` into `staging` (or deploy the branch to the Railway `staging` API) so migrations 0088 to 0094 run   | Dennis          |
| P2  | Leave `PRIVY_EARN_VAULT_ID` **unset** in Doppler `stg` until check L1 is done, then set it to `ry2qt6co7rkpwkr5mqudloo4`  | Dennis          |
| P3  | A test company on staging with an active NEAR company wallet, two admins (A and B), an accountant and an employee         | Dennis + Claude |
| P4  | About 30 USDC on NEAR in that company wallet, sent as a fund-in                                                           | Dennis          |
| P5  | A Railway tunnel to the staging database: `npx -y @railway/cli@5.71.0 connect Postgres -e staging --tunnel-only -P 55433` | Dennis          |
| P6  | Push notifications and email reaching admin A's phone and inbox                                                           | Dennis          |

### The QA driver (to build first)

There is no Treasury screen yet, and every money action needs a passkey. As `scripts/test-payout.ts` did for payouts, a script stands in for the app: `apps/api/scripts/treasury-qa.ts`. It uses a software passkey kept in a git-ignored, owner-only file, and calls the same services the routes call.

| Command                                                             | What it does                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `enrol --organization-id <id> --admin-email <email>`                | Enrols the software passkey for that admin                                                        |
| `status --organization-id <id>`                                     | Same as `GET /treasury`                                                                           |
| `turn-on --organization-id <id> --admin-email <email>`              | Passkey challenge, then turns Treasury on                                                         |
| `preview --organization-id <id> --usdc <amount>`                    | Same as `POST /treasury/moves/preview`                                                            |
| `move --organization-id <id> --admin-email <email> --usdc <amount>` | Passkey challenge, then starts a move to Treasury                                                 |
| `moves --organization-id <id>`                                      | The move history                                                                                  |
| `inspect --organization-id <id> --move-id <id>`                     | The move, its quotes, its Earn calls, its ledger rows and the vault position, with explorer links |
| `reconcile --organization-id <id>`                                  | The ledger against what the company wallet and transit wallet hold on chain                       |

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

| Feature | What the tests prove                                                                         | Where                                                                |
| ------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T1      | Turning on twice makes one wallet, one audit entry and one email                             | `routes/treasury.test.ts`                                            |
| T1      | A wallet with the wrong owner, policy or signer is refused, and nothing is marked on         | `routes/treasury.test.ts`                                            |
| T1      | Unavailable while the vault ID is unset; refused for a Base or not-yet-active company wallet | `routes/treasury.test.ts`                                            |
| T1      | The policy is exactly: Earn into one vault, Earn out of it, the capped USDC transfer         | `services/wallet-policy.test.ts`                                     |
| T2      | Each entry type has the right sign and its move; one debit per quote; no deletes             | `db/treasury-ledger.test.ts`                                         |
| T2      | A payout, bill, claim, float or withdrawal can't spend money reserved for an open move       | `services/treasury-reservation.test.ts`                              |
| T2      | Money back from Treasury is credited once; an ordinary hop refund or sweep is still skipped  | `services/treasury-reservation.test.ts`                              |
| T3      | A move over the cap goes in parts, one at a time, each within the cap                        | `services/treasury-moves.test.ts`                                    |
| T3      | Every row of spec section 11 for this direction                                              | `services/treasury-moves.test.ts`                                    |
| T3      | Running each step twice, or after a crash, never sends or deposits twice                     | `services/treasury-moves.test.ts`                                    |
| T3      | Only what the quote delivered is deposited, never the Treasury wallet's whole balance        | `services/treasury-moves.test.ts`                                    |
| T3      | A refunded part is credited back through the real deposit watcher                            | `services/treasury-moves.serial.test.ts`                             |
| T3      | Preview, confirm and start; roles; 409 for a second open move                                | `routes/treasury-moves.test.ts`                                      |
| T3      | Privy Earn calls and how their failures are read                                             | `services/privy-earn.test.ts`                                        |
| All     | Accountants can't change anything; no staff route reaches a money path                       | `routes/accountant-access.test.ts`, `routes/internal-routes.test.ts` |

---

## 3. Live checks on staging

Record every result in section 5, with the transaction hashes. Base explorer: `https://basescan.org/tx/<hash>`. NEAR explorer: `https://nearblocks.io/txns/<hash>`.

### T1: turning Treasury on

- [ ] **L1. Unavailable without a vault.** With `PRIVY_EARN_VAULT_ID` unset, `status` shows `unavailable` and `turn-on` is refused. Then set the secret (P2) and redeploy.
- [ ] **L2. Off before it's turned on.** `status` shows `off`.
- [ ] **L3. Who can do what**, against the staging API with each person signed in:
  - accountant: `GET /treasury` works; `POST /treasury/confirmations` and `POST /treasury/moves/confirmations` give 403
  - employee: every Treasury route gives 403
- [ ] **L4. Turn on.** `turn-on` as admin A shows `on` and an address. Then check:
  - in the Privy dashboard: a wallet with external ID `treasury-<organisation ID>`, owned by the management quorum, with the runtime signer as its only additional signer and one policy with three rules
  - the audit log has `treasury.turned_on`
  - admins A and B each got the email
- [ ] **L5. Turn on again.** Still one Treasury wallet in Privy, no second audit entry, no second email.

### T3 and T2: moving money to Treasury

- [ ] **L6. Preview.** `preview --usdc 10` shows 1 part, a cost under 0.05 USDC, an estimated time, and what's available. Nothing is saved: `moves` is unchanged.
- [ ] **L7. Refusals, each with nothing saved:**
  - `preview --usdc 9.99`: "The least you can move to Treasury is 10 USDC."
  - `preview` for more than what's available: refused
  - with the company's payouts paused from the staff app: `move` refused with "Payouts are paused…". Unpause afterwards.
- [ ] **L8. First real move, 10 USDC.** `move --usdc 10` as admin A, then `inspect` every 15 seconds until it ends. Expect, in order:
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
- [ ] **L11. A move in parts.** In the staging database, set the test company's `wallets.per_transaction_max_usdc` to `6000000` (6 USDC). Move 10 USDC. Expect 2 parts, one after the other, each with its own quote, debit and Earn deposit, and the move `completed`. Put the cap back to `3100000000` afterwards.
- [ ] **L12. Restart in the middle.** Start a 10 USDC move and restart the staging API service on Railway right after the send appears. After it comes back, the move completes, with exactly one send, one `to_treasury` row and one successful Earn deposit per part.
- [ ] **L13. The ledger matches the chain.** After all of the above, `reconcile` shows the ledger balance equal to what the company wallet and transit wallet hold.
- [ ] **L14. History.** `GET /wallet/history` shows each part as "Moved to Treasury" with the amount that left. Check it in the web dashboard's wallet history too.

### Not forced live (automated only)

These can't be triggered on demand without risking money, so the automated tests are the evidence:

- 1Click refunding a part (credited back as `from_treasury`, move `returned`)
- Privy rejecting a vault deposit three times (move to review)
- An Earn call or a send whose outcome stays unclear (repeated with the same key, then review)
- USDC sent to the Treasury wallet by someone else (never deposited)

---

## 4. Hygiene

- [ ] Typecheck, lint, format and `db:generate` clean (section 2)
- [ ] No keys or passkey files committed; the driver's passkey file is under `apps/api/.cache/`, which git ignores
- [ ] No `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] The test company's cap restored after L11, and its payouts unpaused after L7
- [ ] Every live result recorded in section 5

---

## 5. Results

| Check     | Date | Result | Evidence (tx hashes, move IDs, times) |
| --------- | ---- | ------ | ------------------------------------- |
| Automated |      |        |                                       |
| L1        |      |        |                                       |
| L2        |      |        |                                       |
| L3        |      |        |                                       |
| L4        |      |        |                                       |
| L5        |      |        |                                       |
| L6        |      |        |                                       |
| L7        |      |        |                                       |
| L8        |      |        |                                       |
| L9        |      |        |                                       |
| L10       |      |        |                                       |
| L11       |      |        |                                       |
| L12       |      |        |                                       |
| L13       |      |        |                                       |
| L14       |      |        |                                       |

**Where the QA money ends up:** about 30 USDC in the test company's Treasury, earning, until T4 can move it back.
