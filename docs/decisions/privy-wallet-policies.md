# Decision: Privy wallet policies (T5 · EXP-273)

_2026-11-01. Answers the build check in spec §7.5._

## Answers

1. **Can a policy limit a wallet to `transfer` on the USDC contract only, under a maximum amount? Yes.** A rule that checks the contract (`to`), the chain (`chain_id`) and the decoded `transfer.amount` (`lte`) allows only that. Approvals, `transferFrom`, other tokens, native ETH, empty calldata and other chains are all denied. Amounts compare as numbers, in hex or decimal. The cap binds the owner key too.
2. **Can the allowlist be updated through the API? Yes.** Addresses go in a _condition set_ that a rule references (`in_condition_set`). Items are added and removed over REST, and policy rules are edited over REST too. Every change needs the owner's signature. The backend's signer key and the app secret can't make any of these changes.

**Recommendation: keep Paycrest's Sender API.** Privy can cap amounts, so there's no need to move payouts to Paycrest's gateway contract. The gateway wouldn't add safety anyway: an order's KES recipient is encrypted in the call, so a policy can't check it.

## Evidence

`apps/api/scripts/spike-privy-policy.ts` ran against the Expendi Business Privy app (ID ending `gns2d6`) with `@privy-io/node` 0.37.0. It used `eth_signTransaction` only, so nothing was broadcast and the wallet needed no funds.

- **Run:** `t5-spike-2026-11-01T15-44-11-891Z`
- **Result:** 31 steps, 0 unexpected. The report is saved (git-ignored) at `apps/api/.cache/spike-privy-policy/`.
- **Resources:** wallet `rfk7lw961ckfv4ecba18qgqk` (`0x48206D9bAFD8FEeB38a25Dfc27992D36F15F5253`), policy `kx9tbfs2naz58cqeqe6f1nci`, condition set `iw4x9zj5grvdwtzcrexla3nn`.

**Setup:**

- **Wallet owner:** a "management" key quorum.
- **Additional signer:** a "runtime" key quorum, standing in for the API.
- **Policy, owned by the management key, with two `ALLOW` rules:**
  - USDC on Base to any recipient, with an amount ≤ 1,000 USDC
  - USDC on Base to a recipient in the allowlist condition set, any amount

| Step                                                           | Signed by                | Result                              |
| -------------------------------------------------------------- | ------------------------ | ----------------------------------- |
| USDC 1,000 (at the cap)                                        | runtime                  | allowed                             |
| USDC 1,000.000001                                              | runtime                  | denied (`policy_violation`)         |
| USDC 0.000005 and 999.999999 (would fail a string comparison)  | runtime                  | allowed                             |
| USDC 10 with the contract address in lowercase                 | runtime                  | allowed                             |
| USDC `approve`, USDC `transferFrom`                            | runtime                  | denied                              |
| WETH `transfer`, native ETH (1 wei), USDC with empty calldata  | runtime                  | denied                              |
| USDC `transfer` with chain ID 1 instead of 8453                | runtime                  | denied                              |
| USDC 50,000 to an allowlisted address / to any other address   | runtime                  | allowed / denied                    |
| USDC 10 with the app secret and no signature                   | none                     | denied (401)                        |
| USDC 10 / over the cap                                         | management               | allowed / denied                    |
| Raise the cap; add to the allowlist; remove the policy; export | runtime                  | all denied (401)                    |
| Raise the cap                                                  | none                     | denied (401)                        |
| Lower the cap to 500 USDC, written as a decimal string         | management               | done                                |
| USDC 500 / 500.000001 / 60 / 999.999999 under the new cap      | runtime                  | allowed / denied / allowed / denied |
| Allowlist a new address → USDC 50,000 to it                    | management, then runtime | done → allowed                      |
| Remove that address → USDC 50,000 to it                        | management, then runtime | done → denied                       |

Policy and allowlist changes took effect within the 3 seconds the script waited.

## What the docs say

- No rule for a method means that method is denied. `DENY` beats `ALLOW`, and all conditions in a rule must hold. ([Policies overview](https://docs.privy.io/controls/policies/overview))
- The official ERC-20 cap example uses `field_source: "ethereum_calldata"`, `field: "transfer.amount"` and `lte`. ([Ethereum example policies](https://docs.privy.io/controls/policies/example-policies/ethereum))
- Condition sets are reusable value lists. Creating one needs an owner, and changing items needs the owner's signature. ([Condition sets](https://docs.privy.io/controls/policies/condition-sets))
- Rules can be added, edited and deleted after creation. "If a policy has an owner, the owner's signature is required to modify the policy." Without an owner, the app secret alone can change it. ([Update a policy](https://docs.privy.io/controls/policies/update-a-policy), [Create a policy](https://docs.privy.io/controls/policies/create-a-policy))
- Owners can update policies, owners and signers, and can export the key. Signers can only sign, within policy. ([Owners and signers](https://docs.privy.io/controls/authorization-keys/owners/overview))
- A wallet has at most one policy. ([Update wallet](https://docs.privy.io/api-reference/wallets/update))
- A policy violation deletes the idempotency record, so a retry with the same key is evaluated again. ([Idempotency keys](https://docs.privy.io/api-reference/idempotency-keys))

## Design for T6

**Who controls each wallet:**

- **Owner: a management key quorum.** Its private key never reaches the API. The API creates wallets, policies and condition sets owned by it using only the quorum ID, with no signature needed (the spike did exactly this).
  - Only an ops script holding the management key can change a cap, change signers or export a key.
- **Signer: one runtime key quorum for the API.** Its private key is in the API's Doppler config.
  - It can sign only what the policy allows.
  - The app secret alone can sign nothing, so a leaked app secret can't move money.
- **This fixes the consumer backend's audit finding** that wallets had no owner and the runtime could change its own limits (`backend/docs/privy-security-reference-notes.md` §1).

**One policy per company wallet**, created with the wallet:

- **Rule:** `eth_sendTransaction` (gas-sponsored, since Expendi pays gas) to the USDC contract on chain 8453, with `transfer.amount` ≤ the company's per-transaction maximum.
- **Nothing else is allowed:**
  - no `eth_signTransaction`, `personal_sign` or typed-data signing
  - no `transfer` wallet action
  - no export

  Privy denies every method the policy doesn't name.

**The allowlist stays in the backend (T33).** Rule 1 must allow any recipient, because Paycrest gives a new deposit address for every order. So a Privy allowlist would only matter for amounts above the cap. Withdrawals larger than the cap are split into several transfers. If companies need large single withdrawals later, add the allowlist rule from the spike, with the condition set owned by the management key. Adding an address would then need an Expendi ops signature.

**A Privy-level daily cap isn't used.** Privy's rolling sums ("aggregations") don't fit:

- they allow at most 10 per app, so not one per company
- they only cover `eth_signTransaction` and user operations, not the sponsored `eth_sendTransaction`
- they update after signing, so concurrent requests can pass together

The backend's daily cap and payroll cap (T8) stay the control for totals. Privy bounds each single transaction. ([Stateful policies](https://docs.privy.io/controls/policies/stateful-policies))

## Still to prove (Checkpoint B)

- **The same rules on `eth_sendTransaction` with gas sponsorship.** The spike only signed. With sign-and-send, Privy simulates the transaction before evaluating the policy, so a denial can only be shown with a funded wallet. It's already in the Phase 1 live QA: "Sending a non-USDC token, or an over-limit USDC transfer, directly through Privy is blocked by the policy."
- **Gas sponsorship works for server wallets on Base** in this Privy app (dashboard setting, T6).
- **USDC on Base is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.** Confirm it against [Circle's contract list](https://developers.circle.com/stablecoins/usdc-contract-addresses) in T6.

## Gotchas found

- Rule names must be under 50 characters.
- SDK 0.37 can only list condition sets. Creating sets and adding or removing items goes through REST, signed with `privy.utils().requestSigner()`.
  - Adding items returns a bare array of `{ id, value }`.
  - A request with no body (DELETE) is signed over `""` and must not send `content-type: application/json`, or Privy rejects the signature.
- Errors:
  - a policy denial is HTTP 400 with `code: "policy_violation"`
  - a missing signature is 401
  - a signature from a key that isn't allowed is 401 `invalid_data`
- The contract address in `to` matches regardless of case.
- Each spike run leaves an empty wallet that nobody can use, since its owner key is discarded. The resources are named `t5-spike-*` and `t5-probe-*`.

## Decided (Dennis, 2026-11-01)

1. **The per-transaction maximum is 3,100 USDC by default.** That's just above Paycrest's largest KES order today (about 3,000 USDC) plus its fee. A larger payment is split into several transfers. Ops can raise a company's cap with the management key.
2. **Dennis holds the management key,** ops-only. The private key lives in a Doppler config the API's token can't read, with an offline backup. Losing it doesn't stop payouts, but caps and signers could no longer be changed.
