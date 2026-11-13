-- Treasury moves (docs/work/treasury/spec.md, "Ledger and data"): one row per
-- admin action that moves USDC between the company wallet and the Treasury
-- wallet. No DELETE: a move is the record of where a company's money went.
--
-- Anyone in the company's scope can read: the reservation (availableUsdc)
-- is read by every flow that spends from the wallet, and a policy that hid
-- an open move from one of them would silently let that flow spend what the
-- move reserved. No route shows a move to an employee. Only an admin starts
-- one, and a scope with no role is a system job moving it along, as in 0085.
GRANT SELECT, INSERT ON treasury_moves TO expendi_business_app;
--> statement-breakpoint
-- What was asked, for whom and under which approval never changes; a move
-- only settles.
GRANT UPDATE (status, moved_usdc, cost_usdc, failure, settled_at, updated_at) ON treasury_moves TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE treasury_moves ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE treasury_moves FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY treasury_moves_select ON treasury_moves FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY treasury_moves_insert ON treasury_moves FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint
CREATE POLICY treasury_moves_update ON treasury_moves FOR UPDATE
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

--> statement-breakpoint

-- A move to the wallet (docs/work/treasury/spec.md, section 4): the job now
-- advances moves in both directions, and a withdrawal records what its
-- transaction delivered to the Treasury wallet.

-- Saved once, after the withdrawal succeeds, from the transaction's logs.
GRANT UPDATE (delivered_usdc) ON treasury_earn_actions TO expendi_business_app;
--> statement-breakpoint

-- Open moves of either direction from any company, least recently moved
-- first (IDs only; each is advanced in its company's scope), for the
-- treasury-moves station job.
CREATE OR REPLACE FUNCTION treasury_moves_to_advance(max_rows integer)
  RETURNS TABLE (move_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.organization_id
    FROM treasury_moves m
    WHERE m.status = 'open'
    ORDER BY m.updated_at, m.id
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_moves_to_advance(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION treasury_moves_to_advance(integer) TO expendi_business_app;
