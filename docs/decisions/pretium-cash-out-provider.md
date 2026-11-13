# Decision: Pretium is a second cash-out provider, chosen by one staff setting

_2026-11-13. Dennis, in the design session for the Pretium integration (branch `feat/pretium-cash-out`)._

Expendi staff choose one active cash-out provider, Paycrest or Pretium, for every company at once. We chose a single setting on the Controls page over per-company or per-rail routing and over automatic failover, because one row is easy to reason about in an incident, and because retrying a cash-out on the other provider is only safe when the first provider can prove it will never pay, which neither API does cheaply. Paycrest stays the default.

Terms are defined in `CONTEXT.md`.

## What is different about Pretium

Paycrest issues an order with its own deposit address. The API checks that order before any USDC moves, and a failed order refunds on chain by itself. Pretium has no order: USDC is sent to one fixed settlement address first, and Pretium learns about the cash-out afterwards from the transaction hash. We accepted this send-first model, as the Expendi consumer backend already does, over holding a prefunded shilling balance at Pretium, because a float would put company money in an Expendi treasury on its way out.

The pre-send order checks therefore can't exist for Pretium. These replace them:

- **The settlement address is pinned in the code.** It never comes from an API response at payment time. Pretium's account must report the same address for Base before staff can make Pretium active. If the address ever differs, Pretium cash-outs stop; money is not redirected.
- **The API computes the USDC amount itself** from Pretium's rate, and the approved maximum debit caps it, as it does for Paycrest.
- **Pretium rejects a transaction hash it has already processed**, so a repeated request can't pay twice.

## Rules

1. **The setting.** Only an `ops_admin` changes it, with a reason and a second confirmation, and the change is audited. A change is refused unless the target provider is ready at that moment: key configured, rate answering, and for Pretium the pinned address matching.
2. **A cash-out takes its provider when an admin approves it,** in the transaction that reads the pause flags. Cash-outs still waiting for approval follow a change; approved ones finish with the provider they have. Both providers' callbacks and reconciliation always run.
3. **A Pretium cash-out** makes the Base hop as before, sends USDC from the transit wallet to the settlement address, saves the hash, then tells Pretium the hash and the shilling amount with no Expendi fee. If Privy's reply has no hash, the API asks Privy for it by the send's transaction ID, and the cash-out goes to review if Privy can't give one. It never takes a hash from Base logs: a guessed hash could name another transfer, and Pretium would pay against it.
4. **Status comes from Pretium's status endpoint.** A callback only prompts that read, and a job re-checks every minute. Callbacks must carry Pretium's signature.
5. **When the shillings aren't paid after the USDC was sent,** the API asks Pretium for the refund once. The cash-out is `failed`, and so open to a retry, only when that refund reaches the transit wallet, matched by the refund's transaction hash. The usual sweep returns it. A refused or late refund is `needs_review`.
6. **Banks.** Expendi keeps its own bank catalogue, keyed by the codes payees already hold, with each provider's code. A bank the cash-out's provider can't pay is refused before anything is sent.
7. **Customers don't see provider names.** Rates and fees shown in the apps follow the active provider; the names appear only in the ops admin.

## What this costs us

- A Pretium cash-out that fails after the send leaves the company's USDC with Pretium until the refund lands. With Paycrest the same failure usually sends nothing.
- Business shares the consumer backend's Pretium account and key, so the settlement address, the transaction list and the signing key are shared. Business matches only its own hashes and sends its own callback address.
- Pretium has no sandbox and NEAR Intents has no testnet. The refund destination, the bank codes and the phone number format are proved only by small real cash-outs on staging.
- Pretium pays at most KES 250,000 in one cash-out, so payroll splits larger salaries lower than it does for Paycrest.
- Paycrest's and Pretium's bank lists must be kept matched by hand in the catalogue.

Not built: per-company or per-rail choice, automatic failover, recipient name checks, Airtel, Pretium fund-ins, and currencies other than shillings.
