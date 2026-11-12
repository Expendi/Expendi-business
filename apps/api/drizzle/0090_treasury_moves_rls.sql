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
