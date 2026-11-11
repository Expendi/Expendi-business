-- NEAR Intents quotes (docs/decisions/near-main-chain.md): company-scoped.
-- The API saves a quote and moves it through its statuses.
-- No DELETE: a quote is the record of where a company's money may have gone.
GRANT SELECT, INSERT, UPDATE ON intent_quotes TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE intent_quotes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE intent_quotes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY intent_quotes_select ON intent_quotes FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY intent_quotes_insert ON intent_quotes FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY intent_quotes_update ON intent_quotes FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
