# Expendi Business

Expense management for companies in Kenya: staff spending, approvals, payments and accounting, funded from a USDC wallet Expendi holds for each company.

## Language

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
