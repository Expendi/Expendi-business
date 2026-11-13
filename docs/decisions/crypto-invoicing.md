# Decision: crypto invoicing on NEAR Intents, modelled on Acctual

_2026-11-12. Dennis, after the NEAR port reached staging._

A company sends its customer an invoice in US dollars. The customer opens a link, needs no account, picks the chain they hold USDC on, and sends the invoice total to a deposit address NEAR Intents gives for that payment. USDC lands in the company wallet on NEAR, the deposit watcher credits it, and the invoice is paid.

The reference is Acctual's "flexible payment options" (acctual.com, guides.acctual.com) and the plainer invoicing Altitude kept after Acctual joined it (support.altitude.xyz): one emailed link, no payer account, the invoice marks itself paid when the payment confirms, "mark paid" for payments made elsewhere, and four statuses. We copy the behaviour, not the infrastructure: a 1Click quote per payment plays the part of Acctual's generated pay-in address.

Terms are defined in `CONTEXT.md`.

## Rules

### Customers

1. A customer is who a company invoices: name, billing email, optional address and optional tax ID (a KRA PIN for a Kenyan customer). Customers are not payees: a payee is someone the company pays.
2. A customer is archived, never deleted, once an invoice names them.

### Invoices

1. **Currency:** US dollars only. One dollar is one USDC, so no exchange rate is taken or stored.
2. **Amounts:** whole cents. A line is a description, a quantity (up to three decimals) and a unit price; its amount is quantity × unit price rounded half up to the cent. The subtotal is the sum of the lines. One optional tax rate (basis points, label renameable, default "VAT") applies to the subtotal, rounded half up. Total = subtotal + tax. There is no discount field: lower the unit price, as Altitude does.
3. **Number:** the admin may change the suggested next number (`INV-0001`, `INV-0002`, … the highest trailing number in the company plus one). Unique per company. It locks when the invoice is sent. Deleting a draft frees its number; voiding keeps it.
4. **Terms:** on receipt, net 15, net 30 (the default) or a chosen date. They set the due date from the issue date.
5. **Statuses:** `draft` → `open` (sent) → `paid`, or `open` → `void`. Overdue is not a status: an open invoice past its due date (Nairobi date) shows an overdue badge.
   - Draft: editable, deletable.
   - Open: locked. Remind, mark paid, match a deposit, void.
   - Paid: locked. A payment marked or matched by hand can be undone, which reopens the invoice. A payment through the link can't be undone: that money arrived for this invoice.
   - Void: final. A paid invoice can't be voided.
6. **Sending** snapshots the customer and the company onto the invoice (Altitude: customer edits apply to future invoices only), creates the pay link and emails the customer. Remind resends the same email. There are no scheduled reminders yet.

### The pay link

1. `/pay/<public ID>` on the dashboard's origin. The public ID is 32 random bytes, base64url, created when the invoice is sent. It is a capability like Stripe's hosted invoice URLs: anyone with it can see the invoice and pay it, nothing else.
2. A draft's link doesn't exist. A void invoice's link shows it was voided. A paid invoice's link shows it was paid.
3. The customer picks a chain: Base, Ethereum, Arbitrum or Solana (the fund-in chains). Expendi takes a 1Click `EXACT_INPUT` quote: origin = USDC on that chain, amount in = the invoice total, recipient = the company wallet, refunds into the company's NEAR Intents account (`refundType: INTENTS`), deadline two hours, the same request a fund-in makes. Quote purpose `invoice_payment`, linked to the invoice.
4. The customer pays the total; the company receives it less 1Click's fee (cents). The company pays the fees, as Acctual's senders do. Expendi adds no fee of its own yet.
5. Asking again for the same chain returns the open quote while it has more than 30 minutes left, so a page left open or refreshed doesn't take a new quote each time. At most one open quote per invoice per chain.
6. A company whose wallet isn't active can't take payments: the link says so.
7. The page polls the quote. Asking for a quote's status refreshes it from 1Click at most every 15 seconds; the fund-in job refreshes open invoice payment quotes every 30 seconds anyway.

### Matching

1. **Through the link:** the deposit watcher treats a transfer that 1Click lists for an `invoice_payment` quote like a fund-in's delivery: it is a deposit. In the same transaction it records an invoice payment (the quote, the wallet transaction, the USDC received) and marks the invoice paid. An invoice that was voided after the customer started paying is paid anyway, with that noted in the audit log. A second link payment for an already paid invoice is recorded too, so the company can see it and settle it with the customer.
2. **A short, late or excess deposit** is refunded into the company's NEAR Intents account and returned to the company wallet by the fund-in return job, where it is credited as a plain deposit, not matched to the invoice. The admin matches it by hand.
3. **By hand:** "Match a deposit" links an open invoice to a deposit in the company's wallet history that no invoice payment uses yet. "Mark paid" records a payment made outside Expendi: date, optional reference and note.
4. **The customer's receipt** is emailed once a payment is recorded through the link.

### The PDF

1. `/pay/<public ID>/pdf` downloads the invoice as a PDF, behind the same capability as the pay link. The API renders it (pdfkit, Outfit embedded); the web app serves it from the dashboard's origin so emails link to one address.
2. It shows the invoice as the pay page does, stamped PAID (date, USDC received, chain, NEAR transaction), VOID or OVERDUE. An open invoice carries its pay link.
3. The invoice email, the receipt email, the pay page and the invoice detail link to it. It is rendered on each request and never stored.

### Access

Admins create, send and change invoices and customers. Accountants read them. Employees can't see them. The pay routes are public and know only the public ID.

## What this costs us

- An open invoice payment quote, like an open fund-in, holds back crediting of an unexplained transfer from `intents.near` for up to two hours (decision record, "Telling internal transfers from deposits"). Anyone holding a pay link can open up to four such quotes per invoice.
- The pay routes are the API's first public routes that call a paid third party. Reusing open quotes bounds this to four 1Click quotes per invoice per ninety minutes; there is still no rate limit by IP.
- Reusing open quotes isn't race-proof: two first requests at the same moment can both take a quote. Both are bounded by the same limits.
- The receipt email is sent once, after the credit commits, and isn't retried if Resend fails: the watcher never sees that transfer again. Admins get a push notice of every link payment.
- A delivery whose invoice payment can't be recorded rolls its credit back, and the watcher retries that wallet every run. We judged this unreachable for a real quote and preferable to a deposit with no payment.
- Not proved on mainnet yet: that 1Click lists the delivery for an invoice payment quote in the fields the watcher reads, as it does for fund-ins.
- Only USDC on four chains. USDT, cards and bank transfers, which Acctual takes, need more work: other decimals, and fiat collection partners.
- The PDF is rendered on every request to a public route, with no rate limit by IP, like the pay page.
- No recurring invoices, scheduled reminders or Zoho sync yet.
