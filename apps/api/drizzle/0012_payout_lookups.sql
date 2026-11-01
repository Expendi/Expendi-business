-- Narrow cross-company lookups for system work that starts without a company:
-- the Paycrest webhook (it knows only an order ID) and the reconciliation job
-- (it looks across companies for unfinished payouts). Each returns IDs only;
-- the work itself then runs inside that payout's company scope.
--
-- payouts is FORCE row-level security, so these SECURITY DEFINER functions
-- (owned by the migration role) need the owner to be able to read it. This
-- policy grants exactly that, SELECT only, to the owner only. The app role is
-- unaffected.
CREATE POLICY payouts_owner_reads ON payouts FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION payout_by_provider_order(order_id text)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'paycrest' AND p.provider_order_id = order_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payout_by_provider_order(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payout_by_provider_order(text) TO expendi_business_app;
--> statement-breakpoint
-- Unfinished Paycrest payouts, least recently checked first.
CREATE FUNCTION paycrest_payouts_to_reconcile(max_rows integer)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'paycrest'
      AND p.status IN ('approved', 'order_created', 'funding', 'paying')
    ORDER BY p.provider_checked_at NULLS FIRST, p.updated_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION paycrest_payouts_to_reconcile(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION paycrest_payouts_to_reconcile(integer) TO expendi_business_app;
