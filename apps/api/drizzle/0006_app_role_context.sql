-- Role-restricted tables (spec §4: only admins see salaries). The API sets the
-- caller's role in the company per transaction, next to app.org_id and
-- app.user_id:
--   set_config('app.role', <membership role>, true)
-- A missing or blank setting returns NULL, so a policy that requires a role
-- matches no rows.

CREATE FUNCTION app_current_role() RETURNS membership_role
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.role', true), '')::membership_role $$;
