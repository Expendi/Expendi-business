# Decision: a company's Treasury is a Privy Earn position held by its own wallet on Base

_2026-11-12. Dennis, while scoping Treasury (spec: `docs/work/treasury/spec.md`)._

A company's Treasury is a position in one Privy Earn vault on Base, held by a Treasury wallet that belongs to that company alone. Money reaches it from the company wallet on NEAR through NEAR Intents, the same way a Base hop reaches the transit wallet. We chose Base over earning on NEAR because Privy only signs for NEAR: Earn, policies and gas sponsorship need an EVM wallet, so on NEAR the API would be the only check on where the money goes. We chose a third wallet over the transit wallet because the transit wallet holds nothing at rest: the sweep would return a vault withdrawal and the deposit watcher would flag it.

The sidebar item stays **Accounts**. The earning account inside it is **Treasury**, as Mercury and Brex name theirs.

## What was proved

`apps/api/scripts/spike-privy-earn.ts`, run 1, against the real Privy app (Doppler `stg`, shared with `dev`) and Base mainnet with 1 USDC.

**The vault:** Aave USDC Vault, Privy vault ID `ry2qt6co7rkpwkr5mqudloo4`, contract `0xd235ca1a60e9a3d1da56a5083f80037714d21b06`. At the time: 5.19% a year to the company, 0.58% to Expendi, about USD 15.5 million available to withdraw.

**The wallets:** each owned by the management quorum with the runtime quorum as additional signer, as the transit wallet is.

| Wallet         | Privy ID                   | Address                                      | Policy                                             |
| -------------- | -------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Treasury       | `gd90wmwoqhesw5irjd94yx8f` | `0x96a143796b217329457c1fFBfbaD41FC33BE8Ac1` | Earn in and out of the vault, capped USDC transfer |
| Transit policy | `zr7cstaxomq1tipmmr01a1tk` | `0x1F022f9594DE396A4A5C2796fb82E83F0D616aDD` | `companyWalletPolicyRules` as in production        |
| Another vault  | `fua2bjtdag331jswkymrnzd0` | `0x194e1714ad48b12a0dDF83569aA8dBc86c35F8A2` | Earn deposit only into a different vault ID        |

The spike's cap was 1 USDC, so a wrongly allowed transfer would have cost nothing.

**Results**, numbered as in section 12 of the spec:

1. **The runtime key alone can move money in and out.** Deposit of 1 USDC: action `8797a5b9-2f91-45f3-8166-2af43fce8e2b`, [`0x6053…42dd`](https://basescan.org/tx/0x60538d51042d58b70780d10ac525f43823054d16a90b636d6598a1397a5742dd). Withdrawal of all of it: action `0439b37c-fe89-46a4-84bf-f9966bb4ff31`, [`0x27bb…57c4`](https://basescan.org/tx/0x27bb8876d6a9d69f7a82c7e989070663899233a7ad8c8715a92cea9c0f3257c4). Each settled in under 20 seconds.
2. **The Treasury policy refuses everything else**, each with `policy_violation`: a USDC `approve` through `eth_sendTransaction`, a USDC transfer one unit over the cap, and an Earn deposit into the real vault from a funded wallet whose policy names another vault.
3. **The transit policy refuses Earn**, with `policy_violation`, from a funded wallet.
4. **The wallet never holds ETH.** Privy sends each Earn call as an ERC-4337 user operation (entrypoint 0.7) and pays its gas: USD 0.0056 for the deposit and USD 0.0043 for the withdrawal, charged to Privy gas credits.
5. **Retries are safe.** The same idempotency key returns the same action. A new idempotency key with a `reference_id` already used is refused: "A wallet action with this reference_id already exists for this app".
6. **The position.** `assets_in_vault` and `shares_in_vault` are right at once: 1 USDC in shows 0.999999 USDC and 999,994 shares. `total_deposited` and `total_withdrawn` lag by 10 to 20 seconds. `apy_bps` comes back empty, so the rate comes from the vault's details (`user_apy`), not from the position.
7. **Withdrawing all of `assets_in_vault` leaves nothing behind**: 0 shares, 0 assets. The round trip cost 0.000001 USDC, the vault's rounding.
8. **SDK 0.37.0, already installed, has every call**:
   - `privy.wallets().earn().ethereum().deposit(walletId, { vault_id, raw_amount, reference_id, idempotency_key, authorization_context })`, and `.withdraw` with the same fields
   - `privy.wallets().earn().ethereum().vaultDetails(vaultId)`
   - `privy.wallets().earn().ethereum().vaultPosition(walletId, { vault_id })`
   - `privy.wallets().actions.get(actionId, { wallet_id, include: "steps" })`
   - the types are on the `Wallets` namespace of `@privy-io/node/resources`, such as `Wallets.WalletActionResponse`

**Not proved yet:** item 9, NEAR to the Treasury wallet and back through NEAR Intents. It waits on the Base hop being proved on mainnet (`near-main-chain.md`, "What was proved").

## Rules

1. **The Treasury policy** has three `ALLOW` rules: `earn_deposit` and `earn_withdraw`, each with `action_request_body.vault_id` `eq` the vault ID, and the transit wallet's capped USDC transfer. Nothing else.
2. **Send `raw_amount`**, never `amount`. A policy rule on one does not match a request using the other.
3. **Privy checks two things before the policy.** An unknown vault ID is a `404` "Vault not found", and an amount over the wallet's balance is a `400` `invalid_data` "Insufficient balance". Both mean nothing was signed. Never read either as proof that the policy works.
4. **The transaction hash of an Earn call** is the step's `bundle_transaction_hash` (step type `evm_user_operation`), not `transaction_hash`.
5. **Show the rate from `vaultDetails`** (`user_apy`, in basis points). The position's `apy_bps` can be empty.
6. **Read what is in the vault from `assets_in_vault`.** Don't use `total_deposited` or `total_withdrawn` to decide anything straight after a move: they lag.

## What this costs us

- About a cent of Privy gas credits per Earn call, paid by Expendi.
- One more wallet per company, and a third policy to keep in step with the transit wallet's cap.
- The company's own record of its Treasury depends on Privy's position read. Expendi keeps its own record of moves (spec section 8) to check it against.
