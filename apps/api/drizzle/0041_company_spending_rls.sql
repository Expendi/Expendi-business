-- Paid-from accounts (spec §6.17, §6.23, §8): company-scoped. Removal is
-- archiving (UPDATE), so the API never deletes a row. The routes admit
-- admins only; company spending names them, and the Zoho sync (T44) reads
-- them with the company's scope.
GRANT SELECT, INSERT, UPDATE ON paid_from_accounts TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE paid_from_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE paid_from_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY paid_from_accounts_select ON paid_from_accounts FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY paid_from_accounts_insert ON paid_from_accounts FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY paid_from_accounts_update ON paid_from_accounts FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- `expenses.paid_from_account` (free text) gives way to
-- `paid_from_account_id`, a company-checked reference to the list above; the
-- next migration drops it. No code ever wrote the text column, so it should
-- be empty everywhere. Rather than drop a value nobody mapped, stop the
-- deploy if one exists. FORCE row-level security applies to this owner role
-- too, so lift it for the check alone.
ALTER TABLE expenses NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM expenses WHERE paid_from_account IS NOT NULL) THEN
    RAISE EXCEPTION 'expenses.paid_from_account holds values: map them to paid_from_accounts before it is dropped';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
