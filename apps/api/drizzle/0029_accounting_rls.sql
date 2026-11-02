-- Accounting connections and syncs (spec §6.17, §8): company-scoped, like
-- every other company table. Staff reach them only through
-- /internal/companies/:id/zoho, which runs each request in that one
-- company's scope, so these policies hold for staff exactly as they will for
-- T31's sync job. Disconnecting is an UPDATE, so the API never deletes a row.
GRANT SELECT, INSERT, UPDATE ON accounting_connections TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounting_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounting_connections_select ON accounting_connections FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY accounting_connections_insert ON accounting_connections FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY accounting_connections_update ON accounting_connections FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON accounting_syncs TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE accounting_syncs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounting_syncs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounting_syncs_select ON accounting_syncs FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY accounting_syncs_insert ON accounting_syncs FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY accounting_syncs_update ON accounting_syncs FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
-- The public connect page starts with only the link's token, not a company.
-- This resolves the token's SHA-256 hash to its connection and company and
-- nothing more; the page then works inside that company's scope. A hash of
-- 32 random bytes can't be guessed, so the function can't list companies.
--
-- The table is FORCE row-level security, so this SECURITY DEFINER function
-- (owned by the migration role) needs the owner to be able to read it, as in
-- 0012_payout_lookups.sql: SELECT only, to the owner only.
CREATE POLICY accounting_connections_owner_reads ON accounting_connections
  FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION accounting_connection_by_connect_token(token_hash text)
  RETURNS TABLE (connection_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.organization_id
    FROM accounting_connections c
    WHERE c.connect_token_hash = token_hash AND c.status <> 'disconnected'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accounting_connection_by_connect_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION accounting_connection_by_connect_token(text) TO expendi_business_app;
