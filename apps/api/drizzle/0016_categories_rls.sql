-- Expense categories (spec §6.1, §8): company-scoped. Removal is archiving
-- (UPDATE), so the API never deletes a row.
GRANT SELECT, INSERT, UPDATE ON categories TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY categories_select ON categories FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY categories_insert ON categories FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY categories_update ON categories FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
