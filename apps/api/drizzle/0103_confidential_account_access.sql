-- System-scope lookups for the confidential account jobs
-- (docs/work/confidential-accounts/phase-2-design.md, section C). As in 0076,
-- the app role sees one company at a time, so a job that walks every company
-- first asks one of these for IDs only, then works inside each company's scope.

-- Every active company wallet on the main chain whose USDC is kept in a
-- confidential account. Written as "not base" for the reason given in 0076.
CREATE FUNCTION confidential_account_wallets()
  RETURNS TABLE (
    wallet_id uuid,
    organization_id uuid,
    organization_name text,
    address text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.organization_id, o.name, w.address
    FROM wallets w
    JOIN organizations o ON o.id = w.organization_id
    WHERE w.status = 'active'
      AND w.chain <> 'base'
      AND w.balance_home = 'confidential_account'
    ORDER BY w.created_at
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION confidential_account_wallets() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION confidential_account_wallets() TO expendi_business_app;
--> statement-breakpoint

-- Deliveries into a confidential account that succeeded and are not in the
-- ledger yet, from any company (IDs only; each is credited in its company's
-- scope). Newest first: one that can't be credited stays in this list until
-- a person settles it, and must not keep the ones behind it waiting.
CREATE FUNCTION confidential_quotes_to_credit(max_rows integer)
  RETURNS TABLE (quote_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT q.id, q.organization_id
    FROM intent_quotes q
    WHERE q.recipient_type = 'CONFIDENTIAL_INTENTS'
      AND q.status = 'succeeded'
      AND q.ledger_credited_at IS NULL
      AND q.purpose::text IN ('fund_in', 'invoice_payment', 'fund_in_return')
    ORDER BY q.settled_at DESC
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION confidential_quotes_to_credit(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION confidential_quotes_to_credit(integer) TO expendi_business_app;
