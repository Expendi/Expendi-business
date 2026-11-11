-- Saved company wallet sends (docs/decisions/near-main-chain.md):
-- company-scoped. The API creates a send and moves it through its statuses.
-- No DELETE: a signed send is the record of what the chain may have run.
GRANT SELECT, INSERT, UPDATE ON company_wallet_sends TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE company_wallet_sends ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_wallet_sends FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_wallet_sends_select ON company_wallet_sends FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY company_wallet_sends_insert ON company_wallet_sends FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY company_wallet_sends_update ON company_wallet_sends FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
