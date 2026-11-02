-- Accountant exports (spec §6.11). They may include salaries (spec §4):
-- admins and accountants read them, and only admins, or the monthly job in
-- an admin scope, make them. No DELETE on either table.
GRANT SELECT, INSERT ON report_exports TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY report_exports_select ON report_exports FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IN ('admin', 'accountant')
  );
--> statement-breakpoint
CREATE POLICY report_exports_insert ON report_exports FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
-- Links carry no data of their own, but only admins hand them out. The
-- monthly job replaces a link's token when it retries an email, and records
-- when it went out; nothing else changes.
GRANT SELECT, INSERT ON report_export_links TO expendi_business_app;
--> statement-breakpoint
GRANT UPDATE (token_hash, emailed_at) ON report_export_links TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE report_export_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE report_export_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY report_export_links_admins ON report_export_links FOR ALL
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
-- A download link carries only its token. This resolves the token's
-- SHA-256 to the one export it opens and nothing more; a hash of 32 random
-- bytes can't be guessed, so it can't list exports. An accountant's link
-- stops working once they're removed. The tables are FORCE row-level
-- security, so the owner needs read policies for this SECURITY DEFINER
-- function, as in 0029; memberships' is below.
CREATE POLICY report_exports_owner_reads ON report_exports
  FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY report_export_links_owner_reads ON report_export_links
  FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
-- The monthly job starts with no company, and so does a download link.
-- The owner reads only the memberships of accountants who aren't removed
-- (invited ones included: they may not have signed in yet).
CREATE POLICY memberships_export_owner_reads ON memberships
  FOR SELECT TO CURRENT_USER
  USING (role = 'accountant' AND status <> 'removed');
--> statement-breakpoint
CREATE FUNCTION report_export_by_token(hash text)
  RETURNS TABLE (
    export_id uuid,
    organization_id uuid,
    month text,
    expires_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT e.id, e.organization_id, e.month, e.expires_at
    FROM report_export_links l
    JOIN report_exports e ON e.id = l.export_id
    WHERE l.token_hash = hash
      AND (
        l.membership_id IS NULL
        OR EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.id = l.membership_id
            AND m.role = 'accountant'
            AND m.status <> 'removed'
        )
      )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION report_export_by_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION report_export_by_token(text) TO expendi_business_app;
--> statement-breakpoint
-- IDs only; the job reads everything else inside each company's scope.
CREATE FUNCTION monthly_export_companies()
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT m.organization_id
    FROM memberships m
    WHERE m.role = 'accountant' AND m.status <> 'removed'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION monthly_export_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION monthly_export_companies() TO expendi_business_app;
