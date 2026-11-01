-- The company's address allowlist (spec §6.9, §6.19, §7) and the lookup that
-- confirms direct USDC payouts on chain.

-- withdrawal_addresses: company-scoped. Removal is a soft delete (UPDATE),
-- so the API never deletes a row.
GRANT SELECT, INSERT, UPDATE ON withdrawal_addresses TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE withdrawal_addresses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE withdrawal_addresses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY withdrawal_addresses_select ON withdrawal_addresses FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY withdrawal_addresses_insert ON withdrawal_addresses FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY withdrawal_addresses_update ON withdrawal_addresses FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- Direct USDC payouts sent but not yet confirmed on chain, from any company
-- (IDs only; the confirmation runs in the payout's company scope).
CREATE FUNCTION onchain_payouts_to_confirm(max_rows integer)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'onchain' AND p.status IN ('funding', 'paying')
    ORDER BY p.provider_checked_at NULLS FIRST, p.updated_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION onchain_payouts_to_confirm(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION onchain_payouts_to_confirm(integer) TO expendi_business_app;
