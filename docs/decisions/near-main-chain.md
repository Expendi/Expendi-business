# Decision: NEAR is the main chain, with a Base transit wallet for cash-outs

_2026-11-10. Dennis, in the design session for the NEAR port (branch `chain/near`)._

Every company's money sits as USDC in its own company wallet on NEAR. We chose this over holding balances inside the NEAR Intents contract, because an account a person can look up on chain is easier to audit and to explain, and over staying on Base, because NEAR Intents lets a company fund in from any chain and pay a USDC payee on the chain they choose. A company's own account inside NEAR Intents only ever holds a refunded fund-in on its way back to the company wallet (see "Fund-in").

Cash-outs still need Base. Paycrest takes USDC on Base and refunds to a Base address, so each company also has a transit wallet on Base. A cash-out first moves the exact amount from the company wallet to the transit wallet (the Base hop, through NEAR Intents), then pays Paycrest from the transit wallet with the code path that existed before the port. Refunds land in the transit wallet and are swept back.

_Added 2026-11-13: for a company with a confidential account, the reason given above for a public company wallet no longer holds. See `confidential-accounts.md`._

Terms are defined in `CONTEXT.md`.

## What was proved

`apps/api/scripts/spike-privy-near.ts`, run on 2026-11-10 against the real Privy app, NEAR testnet and the NEAR Intents 1Click API:

- Privy creates a NEAR wallet whose address is the 64-hex implicit account ID. The management quorum as owner and the runtime quorum as additional signer work as they do on Base. A raw sign with no authorization key is refused.
- A transaction built with `near-api-js`, signed by Privy raw signing and broadcast by us is accepted.
- A relayer pays gas for a Privy-signed delegate action (NEP-366). The company account spent 0.
- USDC on NEAR needs a one-time storage registration of 0.00125 NEAR per account. A new account is not registered.
- 1Click quotes 5 USDC NEAR to Base at about 22 seconds and Base to NEAR at about 35 seconds, with fixed fees under one cent.

On mainnet, 2026-11-10: the gas relayer, itself a Privy NEAR wallet, registered with the USDC contract in a transaction the API built, Privy signed and the API broadcast (`9HtNEa3es1a6FGcbYRBytbsBU6kBuY26taGsvYZVbdeH`).

On mainnet, 2026-11-11, with `scripts/near-mainnet-smoke.ts`: a company wallet set up by `ensureCompanyWallet` (`cfe4f640…312d02`) received 0.5 USDC from the relayer (`Hdok6k8RBUGxTjkhjokAA884P64MxPmMsPsnnmgGpsS4`), which the deposit watcher classed as internal, then sent 0.2 USDC back as a delegate action the relayer paid for (`8YXj2VoApYJxqtXAPeBqiZMPP1XPRhQyeJQ1zcpe36kB`). Its NEAR balance did not change.

Not proved yet: a real Base hop and Paycrest cash-out on mainnet, and a fund-in return on mainnet. NEAR Intents has no testnet.

## Rules

### Wallets

1. **Company wallet.** A Privy wallet with `chain_type: "near"`, external ID = the organisation ID, owned by the management quorum, with the runtime quorum as additional signer. One per company, never pooled.
2. **Transit wallet.** A Privy Ethereum wallet on Base per company, created exactly as company wallets were before the port, including the Privy policy (USDC on Base only, capped per transaction). External ID = `transit-<organisation ID>` (Privy external IDs allow only letters, digits, `_` and `-`).
3. **Gas relayer.** One Expendi-owned Privy NEAR wallet. It creates each company account on chain, pays its USDC storage registration, and wraps every company delegate action. It also holds the USDC that covers Base hop fees. Company wallets never hold NEAR.
4. A company wallet is `active` only when both wallets exist, the NEAR account exists on chain and is registered with the USDC contract.

### The spend cap

Privy has no policy conditions for NEAR. The per-transaction USDC cap is therefore enforced by the API immediately before it asks Privy to sign, in the one function that builds a company wallet send. The only actions that function can build are a USDC `ft_transfer`, a USDC `ft_transfer_call` to a 1Click deposit address, and an `mt_transfer` inside NEAR Intents of a fund-in USDC token (Base, Ethereum, Arbitrum or Solana USDC, all with 6 decimals, so one cap reads for all) to a 1Click deposit account. The transit wallet keeps the Privy-enforced cap.

### Sending from a company wallet

NEAR sends are broadcast by us, so Privy's idempotency key no longer makes a retry safe on its own.

1. Build the delegate action with an explicit `max_block_height` (about two minutes ahead).
2. Sign it with Privy and **save the signed delegate, its nonce and its expiry before relaying**.
3. Relay it. A retry relays the same saved bytes; the nonce makes a second execution impossible.
4. An outcome is final when the chain shows the delegate executed, or its expiry has passed without it executing. Only then may a new send be built for the same payout.
5. A refusal from Privy means nothing was signed and nothing moved. Anything unclear after signing is `needs_review`, as before.

### The ledger

The ledger stays the single source of a company's balance. It now covers the company wallet and the transit wallet together.

- **Ledger entries:** a fund-in, a fund-in return or a plain USDC transfer arriving at the company wallet (deposit), a payout leaving for a payee or for Paycrest (payout, withdrawal), and a Paycrest refund arriving at the transit wallet (refund).
- **Not ledger entries:** a Base hop, a sweep, a hop refund, and the relayer's fee cover. These move a company's money between its own two wallets, or are Expendi's cost. They are recorded in their own table.
- The deposit watcher must classify every inbound transfer before crediting it. A transfer from the gas relayer, or one that matches an open hop, sweep or hop refund, is internal. Everything else arriving at a company wallet is a deposit. Anything unexpected arriving at a transit wallet is flagged for review, never credited.

### Base hop

1. Take a 1Click `EXACT_OUTPUT` quote for the amount the cash-out needs, recipient = the transit wallet, refund to the company wallet. Verify the quote's signature before using its deposit address.
2. The relayer registers the quote's deposit address with the USDC contract (0.00125 NEAR). 1Click does not do this, and a transfer to an unregistered account fails.
3. The relayer sends USDC to the company wallet to cover what the hop costs beyond the cash-out amount, less any Expendi surplus already sitting in that wallet from earlier hop refunds. Expendi absorbs hop costs.
4. The company wallet sends the quote's amount in to the deposit address with a plain `ft_transfer`.
5. Poll 1Click until `SUCCESS`, `REFUNDED` or `FAILED`. On success the existing Paycrest funding runs from the transit wallet. A payroll run hops once for its total.
6. `EXACT_OUTPUT` always returns its unused buffer to the company wallet, as a separate transfer from `intents.near` a few seconds later. That transfer is internal.
7. Whatever remains in a transit wallet once nothing is in flight is swept back with a Base to NEAR quote.

### Fund-in

_Added 2026-11-11: a fund-in no longer asks for a refund address._

1. A fund-in is a 1Click `EXACT_INPUT` quote from USDC on Base, Ethereum, Arbitrum or Solana, recipient = the company wallet. It refunds into the company's own account inside NEAR Intents (`refundType: INTENTS`, `refundTo` = the company wallet's account), never to an address on the sending chain, so nobody has to give one. Someone sending from an exchange has no address there to give anyway.
2. A refund arrives in that account as the sending chain's USDC token, not as USDC on NEAR. The fund-in return job reads the account's balances of those four tokens every 30 seconds and returns each one with a 1Click `EXACT_INPUT` quote paid from inside NEAR Intents (`depositType: INTENTS`), recipient = the company wallet, refunding into the same account.
3. The company wallet pays it with one `mt_transfer` to the quote's deposit account, signed and relayed like any other company wallet send. The spend cap applies, so a balance over it goes back over several returns.
4. The delivery is a deposit and is credited once, when it arrives: that money never reached the company wallet before. The return costs the company a few cents; Expendi doesn't cover it.
5. One return per company at a time. After a return of a token ends refunded or failed, that token waits 30 minutes before the next try.
6. The balance is read, not worked out from fund-ins, so anything that lands in the account goes back the same way: an overpaid fund-in's excess, a deposit after the deadline, or a return that was itself refunded.

### Telling internal transfers from deposits

Refunds, sweeps arriving on NEAR and other people's withdrawals from NEAR Intents all arrive as a USDC transfer from `intents.near`, so the sender cannot classify them. A transfer is internal only when its transaction hash appears in the 1Click status (`nearTxHashes` or `destinationChainTxHashes`) of a quote we created, or when its sender is the gas relayer. An inbound transfer is not credited while any of the company's own quotes is still unsettled and could explain it.

Transfers are found with the FastNEAR Transfers API (per account, oldest first, with a saved resume token) and each one is confirmed against the RPC at `FINAL` before it is credited. A transfer is identified by its receipt ID, the log's position in that receipt and its position in the event, which is the same whichever indexer found it.

### Payees and withdrawal addresses

A USDC payee or withdrawal address has a payee chain: NEAR, Base or Solana. NEAR is paid directly from the company wallet. Base and Solana are paid through a 1Click quote whose recipient is the payee.

## What this costs us

- The wallet-level cap on the main chain is gone; it is only as strong as the API. The decision in `privy-wallet-policies.md` now describes the transit wallet only.
- A refunded fund-in sits in the company's NEAR Intents account until the next run of the return job, and the return costs the company a few cents. Staff can't resolve a return under review from the chains' evidence, because nothing of it happens on a chain: they check 1Click and the account by hand.
- Every cash-out takes about half a minute longer and depends on NEAR Intents being up.
- NEAR transaction hashes are base58 and case-sensitive. They must never be lowercased.
