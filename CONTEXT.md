# Expendi Business

Expense management for companies in Kenya: staff spending, approvals, payments and accounting, funded from a USDC wallet Expendi holds for each company.

## Language

### Chains and wallets

**Main chain**:
The chain where every company's money sits at rest. It is NEAR.
_Avoid_: Home chain, primary network, settlement chain

**Company wallet**:
The one account on the main chain that holds a single company's USDC. Never shared between companies.
_Avoid_: Treasury, main wallet, NEAR wallet

**Transit wallet**:
A company's own account on Base that holds nothing at rest. Money passes through it on the way to a cash-out, and refunds return to it.
_Avoid_: Base wallet, bridge wallet, refund wallet

**Gas relayer**:
The Expendi-owned account that pays network fees, so a company wallet never holds anything but USDC.
_Avoid_: Paymaster, sponsor, fee wallet

### Moving money

**Fund-in**:
A company adding money to its company wallet by sending a supported asset from any supported chain.
_Avoid_: Deposit, on-ramp, bridge in

**Cash-out**:
A payout the recipient receives as shillings through M-Pesa, a till, a paybill or a bank.
_Avoid_: Off-ramp, fiat payout

**USDC payout**:
A payout the recipient receives as USDC on the payee chain they chose.
_Avoid_: Onchain payout, crypto payout

**Payee chain**:
The chain a USDC payee or withdrawal address receives on.
_Avoid_: Network, destination chain

**Base hop**:
Moving an exact amount of a company's USDC from its company wallet to its transit wallet so a cash-out can be funded.
_Avoid_: Bridge, bridging, swap

**Sweep**:
Returning whatever sits in a transit wallet to the company wallet.
_Avoid_: Reverse bridge, drain

### Cards

**Expendi card**:
A card issued through Expendi that spends from its company's Card balance.
_Avoid_: Company card, corporate card, Lithic card

**Card balance**:
Money a company's admin has set aside from its wallet for its Expendi cards to spend.
_Avoid_: Card float, card wallet, prefund

**Card load**:
Money moved from a company's wallet to its Card balance.
_Avoid_: Top-up, card funding

**Cardholder**:
A signed-in admin or employee who holds an Expendi card. Every Expendi card has exactly one.
_Avoid_: Card user, card owner

**Card purchase**:
One attempt to spend on an Expendi card, from authorization until it settles, is voided or is declined.
_Avoid_: Card transaction, charge

**Card expense**:
The expense recorded when a Card purchase settles, stating its final amount.
_Avoid_: Card claim

**Bank card**:
A card from the company's own bank, used outside Expendi. What's spent on it is recorded as company spending.
_Avoid_: Company card
