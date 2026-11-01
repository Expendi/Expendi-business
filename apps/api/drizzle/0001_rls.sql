-- Company isolation (spec §8). Migrations run as the owner role; the API
-- logs in as a role that is a member of expendi_business_app and never owns
-- a table, so row-level security always applies to it.
--
-- Request context is set per transaction by the API:
--   set_config('app.org_id', <organization id>, true)
--   set_config('app.user_id', <user id>, true)
-- A missing or blank setting means "no context" and matches no rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expendi_business_app') THEN
    CREATE ROLE expendi_business_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO expendi_business_app;
--> statement-breakpoint
CREATE FUNCTION app_current_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- users is global (one person, many companies), so it has no RLS.
GRANT SELECT, INSERT, UPDATE ON users TO expendi_business_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON organizations TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- With a company in context, only that company. With only a user in context
-- (e.g. listing "my companies"), only companies the user belongs to.
CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (
    id = (SELECT app_current_org_id())
    OR (
      (SELECT app_current_org_id()) IS NULL
      AND id IN (
        SELECT organization_id FROM memberships
        WHERE user_id = (SELECT app_current_user_id()) AND status <> 'removed'
      )
    )
  );
--> statement-breakpoint
CREATE POLICY organizations_insert ON organizations FOR INSERT
  WITH CHECK (id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (id = (SELECT app_current_org_id()))
  WITH CHECK (id = (SELECT app_current_org_id()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON memberships TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    OR (
      (SELECT app_current_org_id()) IS NULL
      AND user_id = (SELECT app_current_user_id())
    )
  );
--> statement-breakpoint
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
