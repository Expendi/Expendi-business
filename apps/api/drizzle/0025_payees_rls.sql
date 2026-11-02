-- Payees (spec §6.19, §8): company-scoped. Archiving is an UPDATE, so the
-- API never deletes a row. They hold bank and M-Pesa details, so the routes
-- admit admins only.
GRANT SELECT, INSERT, UPDATE ON payees TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE payees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payees_select ON payees FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY payees_insert ON payees FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY payees_update ON payees FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
