-- USDC payouts delivered through NEAR Intents that are still waiting on
-- their quote, from any company (IDs only; each is followed in its company's
-- scope). The quote lookup alone misses one whose quote settled in a run that
-- stopped before the payout moved.
CREATE FUNCTION usdc_payouts_awaiting_delivery(max_rows integer)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'onchain'
      AND p.status = 'approved'
      AND p.delivery_quote_id IS NOT NULL
    ORDER BY p.updated_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION usdc_payouts_awaiting_delivery(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION usdc_payouts_awaiting_delivery(integer) TO expendi_business_app;
