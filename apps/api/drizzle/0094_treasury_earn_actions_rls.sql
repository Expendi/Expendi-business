-- Privy Earn calls of Treasury moves (docs/work/treasury/spec.md, "Ledger and
-- data"): one row per call. No DELETE: a call is the record of what Expendi
-- asked Privy to do with a company's USDC.
--
-- Anyone in the company's scope can read; only an admin, or a scope with no
-- role (a system job moving the move along, as in 0085 and 0090), writes.
GRANT SELECT, INSERT ON treasury_earn_actions TO expendi_business_app;
--> statement-breakpoint
-- What was asked and under which reference never changes; a call only
-- settles.
GRANT UPDATE (status, privy_action_id, share_amount, tx_hash, call_started_at, failure, settled_at, updated_at) ON treasury_earn_actions TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE treasury_earn_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE treasury_earn_actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY treasury_earn_actions_select ON treasury_earn_actions FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY treasury_earn_actions_insert ON treasury_earn_actions FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint
CREATE POLICY treasury_earn_actions_update ON treasury_earn_actions FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint

-- treasury_moves is FORCE row-level security, so the SECURITY DEFINER lookup
-- below (owned by the migration role) would see no rows: this lets the owner,
-- and only the owner, read it, as intent_quotes_owner_reads does in 0078.
CREATE POLICY treasury_moves_owner_reads ON treasury_moves FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint

-- Open moves to Treasury from any company, least recently moved first (IDs
-- only; each is advanced in its company's scope), for the treasury-moves
-- station job.
CREATE FUNCTION treasury_moves_to_advance(max_rows integer)
  RETURNS TABLE (move_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.organization_id
    FROM treasury_moves m
    WHERE m.status = 'open' AND m.direction = 'to_treasury'
    ORDER BY m.updated_at, m.id
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_moves_to_advance(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION treasury_moves_to_advance(integer) TO expendi_business_app;
