-- Staff approvals to send a Treasury move's USDC back (spec §6.15). Written
-- only by a scope with no role (the staff confirm step, and the station job
-- marking one used), never by a company's own admin: an approval is the one
-- thing that lets the job send from a Treasury wallet at staff's word. It
-- can't be deleted, and only `consumed_at` can change.
GRANT SELECT, INSERT ON treasury_return_approvals TO expendi_business_app;
--> statement-breakpoint
GRANT UPDATE (consumed_at) ON treasury_return_approvals TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE treasury_return_approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE treasury_return_approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY treasury_return_approvals_select ON treasury_return_approvals FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY treasury_return_approvals_insert ON treasury_return_approvals FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IS NULL
  );
--> statement-breakpoint
CREATE POLICY treasury_return_approvals_update ON treasury_return_approvals FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IS NULL
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IS NULL
  );
