# Treasury: earning yield on idle USDC

**Status:** draft, 2026-11-12, for Dennis to review. Nothing is built.

**Applies to:** the code on `staging`, which contains the NEAR port (`chain/near`, commit `a23efb3`). Every file path below is on that branch. `main` does not have the NEAR code yet.

**Read first:** `docs/decisions/near-main-chain.md`, `docs/decisions/privy-wallet-policies.md`, spec sections 6.9 and 7, and `CONTEXT.md`.

**Decided 2026-11-12 (Dennis):**

- The route is NEAR Intents to Base, then Privy Earn. Earning on NEAR itself was turned down.
- The sidebar item stays **Accounts**. The earning account inside it is called **Treasury**, as Mercury and Brex name theirs.
- Each company gets a new Treasury wallet on Base. The transit wallet is not used for this.
- Earn is turned on for the app in the Privy Dashboard.

---

## 1. What we're building

A company's admin can move USDC the company isn't about to spend out of its company wallet into its **Treasury**, where it earns yield, and move it back when it's needed.

The money stays the company's own the whole way. Treasury is a position in a lending vault on Base, held by a wallet that belongs to that one company. Privy's Earn API makes the vault deposit and withdrawal. NEAR Intents carries the USDC between NEAR and Base, on the paths the Base hop and the sweep already use.

**Why Base and not NEAR:** Privy only signs for NEAR. Earn, wallet policies and gas sponsorship all need an EVM wallet. On Base, Privy enforces which vault the money can go to. On NEAR the API would be the only check.

**Why a separate Treasury wallet and not the transit wallet:** the transit wallet holds nothing at rest, and three things depend on that:

- the sweep returns its whole USDC balance once nothing is in flight (`apps/api/src/services/intents/sweep.ts`)
- the deposit watcher flags any USDC arriving there that isn't a Paycrest refund, a Base hop or a sweep (`apps/api/src/services/wallet/deposits.ts`)
- its Privy policy allows a capped USDC transfer and nothing else

A vault withdrawal landing in the transit wallet would be flagged, then swept. A third wallet keeps all three rules as they are.

**How others do it:** Ramp, Brex and Mercury each keep spendable cash and earning money as two named accounts inside one banking item in the sidebar. The earning account can't pay anyone: money goes back to the spendable account first. This spec follows that model.

---

## 2. Scope

### In version 1

- Turning Treasury on, per company
- Move to Treasury and move to wallet, each started by an admin with a passkey
- Treasury as a second account on the Accounts page (mobile and web): its value, what it has earned and the current rate
- Treasury moves in the wallet history, the monthly export and the audit log
- Staff view of positions and stuck moves in the internal admin app, with alerts

### Right after version 1

- **Automatic moves:** keep a set amount in the company wallet and move the rest, and top the wallet up before a payroll run. Ramp, Brex and Mercury all have this. It is left out of version 1 because section 7 of the spec says nothing pays automatically, and that rule needs a decision of its own first.

### Not in version 1

- **Paying straight from Treasury.** A payout only ever spends the company wallet.
- **Zoho Books entries** for Treasury moves and yield. The monthly export carries them first (section 13, item 6).
- **Choosing a vault.** One vault for every company, picked by Expendi.
- **Reward tokens.** Privy's incentive claim is not called. Anything a vault pays in another token stays unclaimed.
- **Companies whose wallet row is `base`** (made before the move to NEAR).
- **Multi-approver sign-off** (two admins must agree). It is a separate feature and would apply to every money action, not only this one.

---

## 3. Language

To add to `CONTEXT.md` under a new heading, **Treasury**.

**Treasury**:
Money a company's admin has moved out of its company wallet to earn yield. It can't be spent until it is moved back.
_Avoid_: Savings, Earn, investment, vault balance

**Treasury wallet**:
A company's own account on Base that holds its Treasury as a position in the vault. It holds no USDC at rest.
_Avoid_: Earn wallet, vault wallet, yield wallet, savings wallet

**Move to Treasury**:
Moving an amount of a company's USDC from its company wallet into its Treasury.
_Avoid_: Deposit, invest, stake

**Move to wallet**:
Moving an amount of a company's Treasury back to its company wallet.
_Avoid_: Withdraw, redeem, unstake

**Yield**:
What a company's Treasury has earned: what it is worth now, less what was moved in, plus what was moved out.
_Avoid_: Interest, returns, rewards, APY

**Vault**:
The lending market Expendi has chosen to hold every company's Treasury. Each company has its own position in it.
_Avoid_: Pool, strategy, fund

**One existing entry changes.** The company wallet's "avoid" list has "Treasury" in it today. Take it out: Treasury now names a different thing, and the two must never be used for each other.

"Deposit" and "withdrawal" already mean money entering and leaving the company. Treasury moves are neither, which is why they have their own words.

---

## 4. How money moves

### Move to Treasury

1. An admin enters an amount, sees the cost and the current rate, and confirms with a passkey.
2. The amount is reserved, so nothing else can spend it.
3. For each part of the amount that fits under the per-transaction cap:
   1. Take a 1Click `EXACT_INPUT` quote from USDC on NEAR to USDC on Base. Recipient: the Treasury wallet. Refund to: the company wallet. Verify the quote's signature.
   2. The gas relayer registers the quote's deposit address with the USDC contract, as it does for a Base hop.
   3. The company wallet sends the part to the deposit address with a plain `ft_transfer`, through `sendUsdcFromCompanyWallet`. The ledger is debited when the chain shows the send executed.
   4. Poll 1Click until the quote settles.
   5. On success, the Treasury wallet deposits exactly what arrived into the vault with one Privy Earn call.
4. The move is complete when every part's vault deposit has succeeded.

Parts run one at a time. No new action is added to the company wallet: a transfer to a 1Click deposit address is already one of the three it can build.

### Move to wallet

1. An admin enters an amount, or chooses all of it, and confirms with a passkey.
2. The Treasury wallet withdraws that amount from the vault with one Privy Earn call.
3. Read what actually arrived in the Treasury wallet. A vault can fill a withdrawal only partly.
4. For each part of what arrived that fits under the cap, take a 1Click `EXACT_INPUT` quote from USDC on Base to USDC on NEAR. Recipient: the company wallet. Refund to: the Treasury wallet. The Treasury wallet pays the deposit address through Privy, as the transit wallet does for a sweep.
5. Each delivery is credited to the ledger when the deposit watcher confirms it at `FINAL`.
6. The move is complete when every part has been delivered.

### How long and what it costs

|                                                   | Move to Treasury | Move to wallet   |
| ------------------------------------------------- | ---------------- | ---------------- |
| One part                                          | about 30 seconds | about 45 seconds |
| 1Click cost per part                              | under one cent   | under one cent   |
| Parts for 20,000 USDC at the default cap of 3,100 | 7                | 7                |

Times come from the spike figures in `near-main-chain.md` (22 seconds NEAR to Base, 35 seconds Base to NEAR) plus a Base transaction. They are not yet measured for this flow.

**Who pays:** the company pays the 1Click cost, which is why the quotes are `EXACT_INPUT` with no fee cover. Expendi pays the gas on Base and the deposit address registration on NEAR.

---

## 5. Requirements

To become section 6.26 of `docs/expense-mvp-spec.md` once agreed.

### Where it lives

- The sidebar item stays **Accounts** (`apps/web/src/config/navigation.ts`, the item that opens `/wallet`). No new sidebar item.
- The Accounts page lists a company's accounts: its company wallet first, then its Treasury. Each opens to its own detail.
- Before Treasury is turned on, its place on the page is an invitation to turn it on, with the current rate.

### Turning Treasury on

- Admin only, with a passkey, once per company.
- The admin must tick an acknowledgement before confirming. It says, in plain words: yield is not guaranteed, the rate changes, money in Treasury can lose value, the vault is run by a third party and not by Expendi, and moving money back takes a few minutes and can be delayed when the vault is short of cash.
- Turning on creates the Treasury wallet. No money moves.
- Only for a company whose wallet is on NEAR and `active`.
- Recorded in the audit log with who and when. Every admin is emailed.
- Hidden for every company while no vault is configured.

### Moving money

- **Who:** admins only. Accountants can see Treasury. Employees can't.
- **Passkey:** both directions need a fresh passkey confirmation bound to the direction, the amount and the company (section 7 of the spec, rule 3).
- **Move to Treasury, most:** what the company wallet has available, which is the ledger balance less everything reserved.
- **Move to wallet, most:** what the Treasury is worth now. "All" is offered as its own choice.
- **Least:** 10 USDC either way, except "all".
- **One at a time:** a company can have one Treasury move open. A second is refused until the first ends.
- **Before confirming, show:** the amount, the estimated cost, how long it should take, and for a move to Treasury the current rate with the words "changes daily, not guaranteed".
- **Daily cap:** Treasury moves don't count against it. The money stays the company's own.
- **Payout pause:** a paused company can't start a move in either direction, as with a sweep. A move already open is finished.

### What the admin sees

On the Treasury account:

- **Value:** what it is worth now in USDC, with the KES equivalent at the Paycrest rate, the same way the wallet balance shows it.
- **Yield so far:** in USDC.
- **Rate:** the vault's current yearly rate after Expendi's share, to two decimals, labelled as changing.
- **A move in progress:** its direction, amount and a plain status ("On its way to Treasury", "On its way to your wallet"). No part counts, quotes or chain names.
- **History:** Treasury moves appear in the wallet history as "Moved to Treasury" and "Moved to wallet", with the amount that left or arrived.

The wallet balance stays what can be spent now. Treasury is never added into it.

If Privy can't be reached, show the last saved value and when it was read.

### When the wallet is short

When an admin tries to pay more than the company wallet has available and the company has money in Treasury, the message says how much is short, how much is in Treasury, and offers "Move to wallet". It doesn't move anything by itself.

### Notifications

- The admin who started a move is told by push when it completes.
- Every admin is told by push and email when a move ends without completing: returned, partly filled, or under review.

### Accountant

The monthly export gains a Treasury section per month:

- value at the start and end of the month
- total moved to Treasury and total moved to wallet
- yield for the month: closing value, less opening value, less net moves in
- what the moves cost

Each move is also a line with its date, direction, amount that left, amount that arrived and transaction references.

### Expendi team

In the internal admin app, per company: the Treasury wallet address, the position, every move with its quotes and Privy actions, and the same evidence view a quote under review has today (`apps/api/src/services/staff/intent-quote-evidence.ts`).

Alerts, through the existing ops alerts:

- a move not settled after 30 minutes
- USDC sitting in a Treasury wallet with no move open
- a company's position at Privy not matching Expendi's record of its moves
- a vault withdrawal that filled only partly

---

## 6. Money safety

Changes to section 7 of the spec.

1. **Named purposes (rule 2):** add "move the company's own money to or from its Treasury". It needs that company's admin, like the rest.
2. **Confirmation (rule 3):** two new passkey purposes, `move_to_treasury` and `move_to_wallet`, and one for turning on, `turn_on_treasury`. Add them to `ConfirmationPurpose` in `apps/api/src/services/approval/passkeys.ts`.
3. **Enforced at the wallet (rule 5):** the Treasury wallet's Privy policy allows three things and Privy refuses everything else:
   - an Earn deposit into the one configured vault
   - an Earn withdrawal from the one configured vault
   - a USDC transfer on Base up to the per-transaction maximum, the same rule the transit wallet has
4. **The company wallet's cap is unchanged.** Every part of a move to Treasury is a company wallet send, so the API's cap check in `company-wallet-send.ts` applies to it. No other function may ask for a company wallet signature.
5. **Where the money can end up.** The 1Click recipient is checked before any send: the company's own Treasury wallet on the way in, its own company wallet on the way out. Both come from the company's `wallets` row, never from the request.
6. **Owner.** The Treasury wallet is owned by the management quorum, with the runtime key as an additional signer, exactly like the transit wallet. Changing the vault means changing the policy, which needs the management key.

---

## 7. Privy

### The Treasury wallet

Created like the transit wallet in `apps/api/src/services/wallet/company-wallet.ts`:

- `chain_type: "ethereum"`
- external ID `treasury-<organisation ID>`
- owner: the management quorum
- additional signer: the runtime key
- its policy attached at creation, because attaching one later needs the owner
- idempotency key `treasury-wallet-<wallet row ID>`

After creation, check the owner, policy and signer are the ones set, as `ensureCompanyWallet` does for the other two.

### The policy

Add `treasuryWalletPolicyRules(vaultId, perTransactionMaxUsdc)` beside `companyWalletPolicyRules` in `apps/api/src/services/wallet/wallet-policy.ts`. Three `ALLOW` rules:

| Rule            | Method                | Conditions                                                    |
| --------------- | --------------------- | ------------------------------------------------------------- |
| Earn deposit    | `earn_deposit`        | `action_request_body.vault_id` `eq` the vault ID              |
| Earn withdrawal | `earn_withdraw`       | `action_request_body.vault_id` `eq` the vault ID              |
| USDC transfer   | `eth_sendTransaction` | the existing three conditions from `companyWalletPolicyRules` |

No amount condition on the Earn rules: both only move the wallet's own money between itself and its own position. Always send `raw_amount`, never `amount`. Privy treats them as different fields in a rule, and base units are what the rest of the API uses.

Privy's docs say a policy that only allows `eth_sendTransaction` refuses Earn, so the transit wallet can't use Earn by accident.

### The calls

`@privy-io/node` 0.37.0, already installed, has all of these. Add them to `PrivyWalletsShape` in `apps/api/src/services/wallet/privy-wallets.ts`.

| What                | Call                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Deposit             | `privy.wallets().earn().ethereum().deposit(walletId, { vault_id, raw_amount, reference_id, idempotency_key, authorization_context })` |
| Withdraw            | `privy.wallets().earn().ethereum().withdraw(walletId, { ...same })`                                                                   |
| One action's status | `privy.wallets().actions.get(actionId, { wallet_id, include: "steps" })`                                                              |
| Position            | `privy.wallets().earn().ethereum().vaultPosition(walletId, { vault_id })`                                                             |
| Vault details       | `privy.wallets().earn().ethereum().vaultDetails(vaultId)`                                                                             |

All five were proved on 2026-11-12 (`docs/decisions/treasury-on-base.md`). The types are on the `Wallets` namespace of `@privy-io/node/resources`.

**What comes back:**

- An action is `pending`, `succeeded`, `rejected` or `failed`. `rejected` means nothing was signed. `failed` means a transaction was sent and reverted.
- Transaction hashes are only in `steps`, and only with `include=steps`. Privy sends Earn calls as user operations, so the hash is the step's `bundle_transaction_hash`.
- Before the policy, Privy refuses an unknown vault ID (`404`) and an amount over the wallet's balance (`400` `invalid_data`). Nothing is signed in either case.
- Position: `assets_in_vault` is what the Treasury is worth now, with yield. `total_deposited` and `total_withdrawn` count Earn calls only, and lag 10 to 20 seconds behind a move.
- Vault details: `user_apy` is the rate to show, in basis points. `available_liquidity_usd` says how much can be withdrawn right now. The position's own `apy_bps` came back empty in the spike, so don't use it.

**No webhooks.** Privy's production webhooks need the Enterprise plan and nothing else here uses them. A station job polls, like every other money path.

**Gas.** Privy's docs say Earn calls are gas-sponsored by default when sponsorship is on for the app. The Treasury wallet never holds ETH.

### Not sending twice

The Earn calls are sent by Privy, so its idempotency key does help here, unlike a NEAR send.

1. Save the action row, with its `reference_id` and amount, before calling Privy.
2. Call with `idempotency_key` and `reference_id` both set to the row's key. Privy honours an idempotency key for 24 hours and refuses a second action with the same `reference_id` in the app.
3. A retry after an unclear answer sends the same key and gets the same action back.
4. After `rejected`, a new attempt needs a new `reference_id`. Use `tr-<row ID>-<attempt number>`, which fits the 64-character limit.
5. Anything still unclear is `needs_review`.

### Vault ID

`PRIVY_EARN_VAULT_ID` in Doppler. It is the ID Privy's Dashboard gives when the vault is set up, not the contract address. While it is unset, Treasury is hidden and every Treasury route answers "not available".

---

## 8. Ledger and data

### The ledger

The ledger stays the single source of what a company can spend. It still covers the company wallet and the transit wallet, and nothing else. Treasury is outside it.

Two new entry types in `WALLET_TRANSACTION_TYPES` (`packages/shared/src/wallet.ts`), with the sign check in `wallet-transactions.ts` extended:

| Type            | Sign     | Written when                                                                                       |
| --------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `to_treasury`   | negative | the chain shows a part's company wallet send executed                                              |
| `from_treasury` | positive | the deposit watcher confirms at `FINAL` a transfer that one of the company's Treasury quotes lists |

A part of a move to Treasury that 1Click refunds comes back to the company wallet as USDC. It is credited as `from_treasury` for exactly what arrived, linked to the move, which ends `returned`.

**The deposit watcher changes.** Today a transfer whose transaction a quote lists is internal and skipped. A transfer listed by a `from_treasury` quote, or by a refunded `to_treasury` quote, is the one case where it must be credited instead, once, by its receipt ID like any deposit. The rule that holds back crediting while a quote is unsettled stays.

**Reserved.** `reservedForPayouts` in `apps/api/src/services/wallet/ledger.ts` is read in three places to work out what's available (`payment-approval.ts:130`, `floats/payments.ts:339`, `withdrawals.ts:149`). Add the undebited part of an open move to Treasury to what's reserved, in one function all three call, so a payout can't spend money on its way to Treasury.

**Fee cover.** `quote-deposit.ts` compares the ledger with what the company's wallets hold to find Expendi's surplus. Check that a Treasury quote in flight, and its refund before it is credited, can't be read as surplus.

### Tables

Suggested shape. The implementer may change it if the rules above still hold.

**`wallets`**, new columns: `treasury_privy_wallet_id`, `treasury_address`, `treasury_privy_policy_id`, `treasury_turned_on_at`, `treasury_turned_on_by`. Unique indexes on the first two, as for the transit columns.

**`treasury_moves`**, one row per admin action:

- `organization_id`, `wallet_id`, `direction` (`to_treasury` or `to_wallet`)
- `requested_usdc`, and `is_all` for a move to wallet
- `status`: `open`, `completed`, `returned`, `failed`, `needs_review`
- `moved_usdc`: what left the wallet, or what reached it
- `cost_usdc`: the difference between the two ends
- who confirmed it, the approval it used, `failure`, `settled_at`
- at most one `open` or `needs_review` row per company, by a partial unique index

**`treasury_earn_actions`**, one row per Privy Earn call:

- `treasury_move_id`, `kind` (`deposit` or `withdraw`), `reference_id` (unique)
- `raw_amount`, `share_amount`, `privy_action_id`, `status`, `tx_hash`, `failure`

**`intent_quotes`**: two new purposes, `to_treasury` and `from_treasury`, and a nullable `treasury_move_id`. Three of its check constraints name purposes:

- `intent_quotes_send_is_from_company_wallet`: add `to_treasury`
- `intent_quotes_intents_side_matches_purpose`: no change, both use `ORIGIN_CHAIN`
- `intent_quotes_fee_cover_is_for_a_company_send`: no change, Treasury quotes have no fee cover

**`treasury_snapshots`**, one row per company per day: `assets_in_vault`, `shares_in_vault`, `user_apy`, read at 00:00 Nairobi time. The export's monthly figures come from these.

---

## 9. API

All under the existing company scope, admin only unless said.

| Route                                            | What it does                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /organizations/:id/treasury`                | Status (`off`, `on`), value, yield, rate, the open move if any. Admins and accountants.                                               |
| `POST /organizations/:id/treasury`               | Turn on. Needs a `turn_on_treasury` confirmation. Resumes a half-finished setup, like `POST …/wallet`.                                |
| `POST /organizations/:id/treasury/moves/preview` | For a direction and amount: the estimated cost, time and number of parts. Moves nothing.                                              |
| `POST /organizations/:id/treasury/moves`         | Start a move. Needs a `move_to_treasury` or `move_to_wallet` confirmation whose intent hash covers the company, direction and amount. |
| `GET /organizations/:id/treasury/moves`          | History. Admins and accountants.                                                                                                      |

Schemas go in `packages/shared/src/treasury.ts`. USDC amounts are base-unit integer strings, as everywhere else.

---

## 10. Jobs

Added to the station (`apps/api/src/station/`):

| Job                       | Every      | Does                                                                                                                        |
| ------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `treasury-moves`          | 15 seconds | Advances every open move by one step: quote, send, poll 1Click, Earn call, poll the action. Each step is safe to run twice. |
| `treasury-snapshots`      | 15 minutes | Writes the day's snapshot once for each company with Treasury on.                                                           |
| `alert-checks` (existing) | 60 seconds | Gains the four Treasury checks in section 5.                                                                                |

---

## 11. When something goes wrong

| What happened                               | What the money did                      | What the app does                                                                                                      |
| ------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A quote can't be had                        | Nothing moved                           | The part isn't started. The move ends `failed`, or `completed` for less if earlier parts landed. Reservation released. |
| Privy refuses the company wallet send       | Nothing moved                           | Same.                                                                                                                  |
| The send's outcome is unclear               | Unknown                                 | `needs_review`, by the existing rule for company wallet sends.                                                         |
| 1Click refunds a part on the way in         | Back in the company wallet              | Credited as `from_treasury`. The move ends `returned`.                                                                 |
| 1Click reports `FAILED`                     | Unknown                                 | `needs_review`.                                                                                                        |
| Earn deposit `rejected`                     | USDC sits in the Treasury wallet        | Retry up to three times. Then send it back to the company wallet on the move-to-wallet path, and end `returned`.       |
| Earn deposit `failed`                       | A transaction reverted                  | `needs_review`.                                                                                                        |
| Earn withdrawal `rejected` or `failed`      | Still in the vault                      | The move ends `failed`. The admin is told and can try again.                                                           |
| Earn withdrawal fills partly                | Part is in the Treasury wallet          | Return what arrived. The move ends `completed` for the smaller amount, and admins are told.                            |
| 1Click refunds a part on the way out        | Back in the Treasury wallet             | Wait 30 minutes, then take a new quote, as a fund-in return does.                                                      |
| A move is unsettled after 30 minutes        | Depends                                 | Ops alert. Staff check it with the evidence view.                                                                      |
| USDC in a Treasury wallet with no move open | Not the company's until someone says so | Ops alert. Never credited automatically.                                                                               |

A move to wallet returns only what its own withdrawal brought, never the Treasury wallet's whole balance, so USDC a stranger sent there can't be credited by accident.

---

## 12. Prove first

**Status, 2026-11-12:** items 1 to 8 proved; item 9 waits on the Base hop on mainnet. Results are in `docs/decisions/treasury-on-base.md`.

A spike script, `apps/api/scripts/spike-privy-earn.ts`, in the style of `spike-privy-near.ts`, on Base mainnet with 1 USDC. Nothing else starts until these hold.

1. A wallet created with the management quorum as owner, the runtime key as signer and the Treasury policy can deposit to and withdraw from the vault with the runtime key alone.
2. Privy refuses, on that wallet: an Earn deposit to a different vault, a direct `approve` through `eth_sendTransaction`, and a USDC transfer over the cap.
3. Privy refuses Earn on a wallet with the transit policy.
4. The wallet holds no ETH at any point.
5. A replayed idempotency key returns the same action, and a second `reference_id` is refused.
6. The position's `assets_in_vault`, `total_deposited` and `total_withdrawn` read as documented, and how soon after a deposit they change.
7. Withdrawing the full `assets_in_vault`: what is left behind as residual shares.
8. The SDK method names for an action's status, the position and vault details, in 0.37.0.
9. A 1Click quote from NEAR delivers to the Treasury wallet, and one paid by the Treasury wallet delivers to the company wallet. This needs the Base hop proved on mainnet first, which `near-main-chain.md` lists as not yet done.

Write the results into a decision record, `docs/decisions/treasury-on-base.md`, as the other two decisions do.

---

## 13. To settle

**Dennis decides:**

1. **The vault.** Privy's Dashboard offers Aave USDC and two Morpho vaults for USDC on Base without talking to sales. My suggestion is Aave USDC: it is the largest and simplest of the three, so a withdrawal before payroll is least likely to stall, at a lower rate than the Morpho vaults usually pay. Check the three rates and sizes in the Dashboard on the day.
2. **Expendi's share of the yield.** Privy can pay Expendi a share: up to 50% on Morpho, up to 100% on Aave. It is set once per vault and belongs in section 11 of the spec. On Aave the share is collected with a separate call, in full each time.
3. **Who pays the move cost.** This spec says the company, under a cent a part.
4. **The cap for Treasury moves.** At 3,100 USDC a part, 20,000 USDC takes seven parts: about four minutes in and five minutes back. Raising a company's cap raises it for everything.
5. **Passkey on the way back.** This spec asks for one. Moving money back to the wallet is the safe direction, so it could go without.

**Ask the accountant:**

6. Which Zoho accounts Treasury and yield should post to, and whether the export alone is enough for now.

**Owner to-dos, before the spike:**

7. Ask Privy what it charges for Earn. The docs don't publish a fee. (Earn itself is on: Dennis turned it on in the Dashboard on 2026-11-12.)
8. ~~Set up the vault in the Privy Dashboard and note its vault ID.~~ Done 2026-11-12: vault ID `ry2qt6co7rkpwkr5mqudloo4`. Which vault it is and Expendi's share are not written down yet; the spike reads both from Privy's vault details.
9. Give the vault's admin wallet an owner. A Privy-made admin wallet has none, so the app secret alone can move Expendi's share.
10. Add `PRIVY_EARN_VAULT_ID` to Doppler for `dev`, `stg` and production.

---

## 14. Tasks

Numbered within this spec. Scope uses the build plan's S, M, L.

### T0: Spike and decision record

Section 12. **Scope:** S. **Blocks everything.**

### T1: Treasury wallet and turning on

The policy rules, the wallet columns, creating and checking the Treasury wallet, the `turn_on_treasury` purpose, `POST` and `GET /treasury` without figures, and the `CONTEXT.md` entries from section 3.

- [ ] Turning on twice makes one wallet
- [ ] A wallet with the wrong owner, policy or signer is refused, as for the other two
- [ ] Hidden and refused while `PRIVY_EARN_VAULT_ID` is unset

**Depends on:** T0. **Files:** `services/wallet/wallet-policy.ts`, `services/wallet/company-wallet.ts`, `services/wallet/privy-wallets.ts`, `db/schema/wallets.ts`, `services/approval/passkeys.ts`, new `services/treasury/`, new `routes/treasury.ts`, `packages/shared/src/treasury.ts`, `CONTEXT.md`. **Scope:** M.

### T2: Ledger, reservation and the deposit watcher

The two entry types, the `treasury_moves` table, the two quote purposes, the shared "available" function, the watcher crediting Treasury deliveries and refunds, the fee cover check, and the history labels.

_Changed 2026-11-13:_ the `treasury_moves` table and the quote purposes moved here from T3, because the reservation and the watcher can't be built without them. T2 doesn't write `to_treasury` debits: T3 does, when it settles a send.

- [ ] Money on its way to Treasury can't be spent by a payout, a float or a withdrawal
- [ ] A Treasury delivery is credited once, and an ordinary internal transfer is still skipped

**Depends on:** T0. **Files:** `packages/shared/src/wallet.ts`, `db/schema/wallet-transactions.ts`, new `db/schema/treasury-moves.ts`, `db/schema/intent-quotes.ts`, `services/wallet/ledger.ts`, `services/wallet/near-deposits.ts`, `services/intents/quote-deposit.ts`, the callers that work out what's available, the wallet history service and displays. **Scope:** M.

### T3: Move to Treasury

`treasury_earn_actions`, writing `to_treasury` debits, the `treasury-moves` job for this direction, the `move_to_treasury` passkey purpose, preview and start routes.

- [ ] A move over the cap goes in parts, one at a time, and every part is within the cap
- [ ] The ledger equals what the company wallet and transit wallet hold after every test move
- [ ] Every row in section 11 that concerns this direction has a test
- [ ] Killing the API at any step and restarting it never sends or deposits twice

**Depends on:** T1, T2. **Files:** `db/schema/`, `services/treasury/`, `services/intents/`, `station/`. **Scope:** L.

**What T1 and T2 left for T3** (2026-11-13):

- Starting a move takes the same wallet-row lock payout approval takes before it reads `availableUsdc`, so a payout and a move started together can't both spend the same money.
- Refuse a move unless `wallets.treasury_turned_on_at` is set.
- Write each `to_treasury` debit with both `treasury_move_id` and `intent_quote_id`. The database allows one debit per quote.
- Nothing sets a Treasury quote's status yet. T3's own settler must mark a `to_treasury` quote `refunded`, or the deposit watcher keeps holding the company's deposits behind it. Treasury quotes need their own refresh job (through `intent_quotes_to_refresh`).
- Credit a refunded part before marking the move `returned`. A move in `needs_review` keeps its reservation, and the staff resolve path settles only the quote, not the move.
- The Earn calls (`deposit`, `withdraw`, `vaultPosition`, `vaultDetails`, `actions.get`) aren't on `PrivyWalletsShape` yet, nor in its fakes.
- `verifyApproval` uses up the passkey challenge before the work runs, so a failure after confirming asks the admin to confirm again.

### T4: Move to wallet

The withdrawal, reading what arrived, the return quotes paid by the Treasury wallet, the rest of section 11.

- [ ] "All" leaves at most dust in the vault
- [ ] A partial fill returns what arrived and says so
- [ ] USDC a stranger sent to the Treasury wallet is never credited

**Depends on:** T3. **Files:** as T3. **Scope:** L.

**What T3 left for T4** (2026-11-13):

- `earnWithdraw` is on `PrivyWalletsShape` and faked, but has never run against the real SDK. Prove it on the spike wallet first.
- `treasury_earn_actions.intent_quote_id` may be null, for a withdrawal that comes before its return quote.
- `from_treasury` quotes need their own opener, paid by the Treasury wallet through Privy as a sweep is paid by the transit wallet.
- `treasury_moves_to_advance()` and the step function cover `to_treasury` only. Preview and start refuse `to_wallet` with 503.
- A move to Treasury whose vault deposit Privy rejected three times goes to `needs_review` with its USDC in the Treasury wallet. T4's return path should give staff a way to send it back.
- Moves in `needs_review` aren't stepped, and the staff resolve path settles only the quote, not the move.

**How T3 differs from this spec:**

- A move whose parts landed only in part completes for the smaller amount and tells every admin, by push and email, that it was partly filled.
- `cost_usdc` is what was debited, less what came back, less what reached the vault.
- A 1Click outage is retried for 5 minutes; a quote 1Click refuses outright fails the move at once; an expired quote is taken again up to 3 times.
- If 1Click reports a delivery without its amount, the move goes to review instead of depositing anything.

### T5: Figures, snapshots and alerts

Position and rate on `GET /treasury`, the snapshot job, the four alert checks, the "wallet is short" message.

**Depends on:** T1. **Files:** `services/treasury/`, `station/`, `services/alerts/alert-checks.ts`, `services/payments/payment-approval.ts`. **Scope:** M.

### T6: Mobile and web

The Accounts page listing the company wallet and Treasury, the Treasury account's detail, turning on, both move flows, history lines. The sidebar item keeps its name. Design comes first as mocks in the design system's tokens, then the build.

**Depends on:** T1 for turning on, T3 to T5 for the rest. **Files:** `apps/mobile/src/app/(admin)/wallet/`, `apps/mobile/src/features/wallet/`, `apps/web/src/app/(company)/wallet/`. **Scope:** L.

### T7: Export, audit log and the internal admin app

The export's Treasury section, audit entries (`treasury.turned_on`, `treasury_move.started`, `treasury_move.completed`, `treasury_move.returned`, `treasury_move.failed`), the staff view.

**Depends on:** T3, T4, T5. **Files:** `services/export/`, `services/audit/`, `services/staff/`, `apps/admin/`. **Scope:** M.

### What can run together

After T0: T1 and T2. After those: T3 and T5, with T6's mocks. Then T4. Then T6's build and T7.

---

## 15. Sources

Privy docs, read 2026-11-12:

- Earn overview, setup, deposit, withdraw, policies: `https://docs.privy.io/wallets/actions/earn/overview.md`, `…/setup.md`, `…/deposit.md`, `…/withdraw.md`, `…/policies.md`
- Position and vault details: `…/earn/get-vault-position.md`, `…/earn/get-vault-details.md`
- Aave and Morpho: `…/earn/providers/aave.md`, `…/earn/providers/morpho.md`
- Action status and steps: `https://docs.privy.io/wallets/actions/status.md`, `https://docs.privy.io/api-reference/wallets/actions/get.md`
- Chain tiers, which put NEAR at sign-only: `https://docs.privy.io/wallets/overview/chains.md`

Not stated in the docs, so not relied on here: a minimum deposit, rate limits, Privy's own fee, and whether the approval inside an Earn deposit is checked against `eth_sendTransaction` rules. Item 2 of section 12 settles the last one.

How others name and place it, read 2026-11-12:

- Ramp: `https://support.ramp.com/hc/en-us/articles/35043351807507-Ramp-Business-Account-Overview`, `https://support.ramp.com/hc/en-us/articles/47000097525651-Ramp-Managed-Investment-Account-Overview`, `https://support.ramp.com/hc/en-us/articles/40845069542419-Ramp-Treasury-Automations`
- Brex: `https://brex.com/support/brex-business-account-updates`, `https://www.brex.com/support/mmf-brex-business-account`
- Mercury: `https://mercury.com/treasury`, `https://support.mercury.com/hc/en-us/articles/28768212621332-Setting-up-auto-transfer-rules`. Mercury's pages refused to load, so its details come from search results only.
