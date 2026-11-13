# Expendi Business

Expense management for companies in Kenya: staff spending, approvals, payments and accounting, funded from a USDC wallet Expendi holds for each company.

## Language

### Chains and wallets

**Main chain**:
The chain where every company's money sits at rest. It is NEAR.
_Avoid_: Home chain, primary network, settlement chain

**Company wallet**:
The one account on the main chain that holds a single company's USDC. Never shared between companies. What it holds is what the company can spend now, unless the company has a confidential account: then that account holds it and the company wallet holds only what is waiting to be moved in, a few cents of dust and any of Expendi's own surplus. Treasury is never part of it.
_Avoid_: Main wallet, NEAR wallet

**Confidential account**:
A company's own account on the private ledger NEAR Intents runs, where its USDC sits instead of in the public company wallet. Off by default, turned on per company by Expendi staff. The company wallet signs for it.
_Avoid_: Private wallet, shielded balance, private account

**Transit wallet**:
A company's own account on Base that holds nothing at rest. Money passes through it on the way to a cash-out, and refunds return to it.
_Avoid_: Base wallet, bridge wallet, refund wallet

**Gas relayer**:
The Expendi-owned account that pays network fees, so a company wallet never holds anything but USDC. It also holds the USDC that refills each fee float.
_Avoid_: Paymaster, sponsor, fee wallet

**Fee float**:
Expendi's own USDC kept inside a company's confidential account to pay what its Base hops and its USDC payouts to other chains cost beyond what they deliver. The gas relayer refills it to a target of 1 USDC whenever it falls below 0.25 USDC. It is never part of the company's balance.
_Avoid_: Float (on its own: petty cash has floats), fee cover balance, gas float, buffer, reserve

### Moving money

**Fund-in**:
A company adding money to its company wallet, or to its confidential account if it has one, by sending a supported asset from any supported chain.
_Avoid_: Deposit, on-ramp, bridge in

**Move-in**:
Moving USDC that sits in a company wallet into the same company's confidential account.
_Avoid_: Shield, deposit, top-up

**Fund-in return**:
Sending a fund-in that couldn't be completed from the company's own NEAR Intents account, where it was refunded, back to its company wallet, or its confidential account, as USDC on NEAR.
_Avoid_: Refund address, reverse fund-in

**Cash-out**:
A payout the recipient receives as shillings through M-Pesa, a till, a paybill or a bank.
_Avoid_: Off-ramp, fiat payout

**Cash-out provider**:
A company Expendi sends a cash-out through, which turns the USDC into shillings and delivers them to the recipient. Paycrest and Pretium are cash-out providers.
_Avoid_: Off-ramp provider, payout provider, PSP, liquidity provider

**Active cash-out provider**:
The cash-out provider that new cash-outs go through, chosen by Expendi staff for every company at once.
_Avoid_: Default provider, primary provider, current rail

**USDC payout**:
A payout the recipient receives as USDC on the payee chain they chose.
_Avoid_: Onchain payout, crypto payout

**Payee chain**:
The chain a USDC payee or withdrawal address receives on.
_Avoid_: Network, destination chain

**Base hop**:
Moving an exact amount of a company's USDC from where its balance sits, its company wallet or its confidential account, to its transit wallet so a cash-out can be funded.
_Avoid_: Bridge, bridging, swap

**Sweep**:
Returning whatever sits in a transit wallet to where the company's balance sits, its company wallet or its confidential account.
_Avoid_: Reverse bridge, drain

### Treasury

**Treasury**:
Money a company's admin has moved out of its company wallet to earn yield. It can't be spent until it is moved back. It is listed under Accounts next to the company wallet.
_Avoid_: Savings, Earn, investment, vault balance

**Treasury wallet**:
A company's own account on Base that holds its Treasury as a position in the vault. It holds no USDC at rest.
_Avoid_: Earn wallet, vault wallet, yield wallet, savings wallet

**Move to Treasury**:
Moving an amount of a company's USDC from where its balance sits, its company wallet or its confidential account, into its Treasury.
_Avoid_: Deposit, invest, stake

**Move to wallet**:
Moving an amount of a company's Treasury back to where its balance sits, its company wallet or its confidential account.
_Avoid_: Withdraw, redeem, unstake

**Yield**:
What a company's Treasury has earned: what it is worth now, less what was moved in, plus what was moved out.
_Avoid_: Interest, returns, rewards, APY

**Vault**:
The lending market Expendi has chosen to hold every company's Treasury. Each company has its own position in it.
_Avoid_: Pool, strategy, fund

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
A signed-in admin or employee who holds an Expendi card. Every Expendi card has exactly one, except a company-held card, which has none.
_Avoid_: Card user, card owner

**Company-held card**:
An Expendi card the company holds, with no cardholder. Only a company-held card can pay a recurring payment, and one card can pay several.
_Avoid_: Company card, subscription card, shared card

**Card purchase**:
One attempt to spend on an Expendi card, from authorization until it settles, is voided or is declined.
_Avoid_: Card transaction, charge

**Card expense**:
The expense recorded when a Card purchase settles, stating its final amount. A Card purchase that pays a bill records none: the bill is the record.
_Avoid_: Card claim

**Bank card**:
A card from the company's own bank, used outside Expendi. What's spent on it is recorded as company spending.
_Avoid_: Company card

### Getting paid

**Customer**:
Someone a company invoices. Not a payee: a payee is someone the company pays.
_Avoid_: Client, buyer

**Invoice**:
What a company sends a customer to be paid in US dollars, settled as USDC in its company wallet, or its confidential account. Draft, open, paid or void; overdue is an open invoice past its due date, not a status.
_Avoid_: Sales invoice, bill (a bill is what the company owes)

**Pay link**:
The public page where a customer sees an invoice and pays it, with no account.
_Avoid_: Checkout, payment page

**Invoice payment**:
Money recorded against an invoice: paid through the pay link, matched by hand to a deposit, or marked paid outside Expendi.
_Avoid_: Receipt, settlement
