-- Approved Pretium cash-outs, for the jobs that start without a company
-- (see 0012). An approved Paycrest cash-out reaches them through
-- paycrest_payouts_to_reconcile; pretium_payouts_to_reconcile (0089) only
-- covers USDC in flight. The outbound quotes job funds one whose Base hop
-- delivered in a run that stopped before funding, and the Pretium job
-- releases one whose approval lapsed. IDs only; the work then runs in the
-- payout's company scope. The provider is named as in 0089.
CREATE FUNCTION pretium_cash_outs_awaiting_funding(max_rows integer)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'pretium'::text::payout_provider
      AND p.status = 'approved'
    ORDER BY p.updated_at, p.id
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pretium_cash_outs_awaiting_funding(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pretium_cash_outs_awaiting_funding(integer) TO expendi_business_app;
