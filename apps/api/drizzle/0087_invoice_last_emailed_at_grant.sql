-- Sending and reminding stamp the invoice so reminders can be paced
-- (docs/decisions/crypto-invoicing.md). Only an admin updates an invoice
-- from a route; the update policy in 0085 already limits who.
GRANT UPDATE (last_emailed_at) ON invoices TO expendi_business_app;
