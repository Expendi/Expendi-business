-- Expenses and their receipt files (spec §5, §6.3, §8, §10): company-scoped.
-- Nothing is deleted through the API. A claim only changes status, and a
-- receipt file stays as the company's duplicate-check record (spec §6.5).
-- Which claims an employee sees (only their own, spec §4) is enforced by the
-- API on top of these policies.
GRANT SELECT, INSERT, UPDATE ON expenses TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY expenses_select ON expenses FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY expenses_insert ON expenses FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY expenses_update ON expenses FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON receipt_files TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE receipt_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE receipt_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY receipt_files_select ON receipt_files FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY receipt_files_insert ON receipt_files FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY receipt_files_update ON receipt_files FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
