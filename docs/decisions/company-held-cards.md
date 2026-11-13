# Decision: company-held cards pay recurring payments

_2026-11-13. Dennis, in the design session for spec §6.20 and §6.25._

Card-only software (Claude, Vercel, Notion) charges a card on file with nobody present. A recurring payment can now be paid **by a company-held card**: an Expendi card the company holds, with no cardholder. Only a company-held card can pay a recurring payment. A company can have any number of them, and one card can pay one recurring payment or several.

## Why the card has no cardholder

Until now every Expendi card had exactly one cardholder, and a leaver's cards close automatically. Lithic can't move a card to another holder after it is created. A subscription on a person's card would therefore break the day that person leaves, and the fix would be a new card number entered at every merchant. A company-held card is issued on the company's own account at Lithic, so nobody leaving affects it. Lithic's sandbox accepted such a card on 2026-11-13.

We considered keeping the card with an admin and warning when that admin is removed. We rejected it because the warning doesn't prevent the break; it only announces it.

## Why the Card purchase is the bill's payment

A card-paid recurring payment still gets a bill each cycle, so the Recurring payments sheet, the overview forecast and "what's due next" keep working, and a purchase that never arrives shows as an overdue bill. When the Card purchase settles, the bill becomes `paid_by_card` and takes the purchase's actual amount. There is no separate Card expense: the bill is the record, it reaches Zoho once, and Expenses doesn't list it, the same as any other bill.

We rejected recording both a Card expense and a bill marked paid, which is what the old "paid outside" workaround produced: the same money counted twice.

## Why purchases pass with nobody approving them

Every other payment needs a click and a passkey. A merchant doesn't wait for one, so a purchase that waited would be declined and the software suspended. The passkey is asked once, when the card is issued, and the controls after that are the card's monthly limit, freezing the card, and pausing the recurring payment, which declines its merchant.

## How a purchase finds its recurring payment

By merchant. A card with one recurring payment links the first merchant that charges it. On a card with several, the first purchase from a new merchant is approved and an admin says once what it is: one of the card's recurring payments, a one-off, or not recognised. We rejected matching by amount and date, because usage-based bills change amount and merchants charge a few days early or late.

Lithic only reveals a merchant's ID when it first charges, which is why a new merchant can't be declined in advance without declining every subscription's first purchase.

## Sandbox stand-ins to remove

- No real merchant can charge a sandbox card, so a job makes the Card purchase on each card-paid bill's due date, and Expendi staff can run it on demand from ops admin. Real merchants replace both.
- Declining a paused, ended or not-recognised merchant happens in the API's purchase check (Auth Stream Access), which is itself a sandbox stand-in (`expendi-card-funding.md`). In production it becomes a rule at Lithic for that card.
