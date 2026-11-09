# Decision: Expendi cards spend from a prefunded Card balance

_2026-11-08. Dennis, in the design session for spec §6.25._

An admin moves money from the company wallet to a Card balance with a passkey, and cards spend from that balance. We chose this over approving each purchase live against the wallet, because a live check would let money leave the wallet with no passkey behind it (spec §7.3), would put our API in every card authorization (Lithic advises answering within 3 seconds and declines at 6), and would still leave USD settlement unsolved. Prefunding also caps what a leaked card can spend at what's been loaded.

The target is Lithic's stablecoin pilot, enabled per program, where Card loads are real USDC transfers to the company's deposit address on Base. Lithic's sandbox can't hold a balance, so for now a Card load is only a record and the API checks each purchase against it through Auth Stream Access. That check is a sandbox stand-in: it should go when real balances arrive, not become the production design.

**Never send USDC to a sandbox address.** Company wallets are hard-coded to Base mainnet and sandbox deposit addresses are on Base Sepolia, so a real transfer would be lost.
