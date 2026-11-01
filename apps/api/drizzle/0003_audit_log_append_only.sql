-- Audit log is append-only (spec §6.13).
--
-- 1. The app role may only INSERT: no SELECT, UPDATE or DELETE.
-- 2. A trigger rejects UPDATE, DELETE and TRUNCATE for every role, the
--    owner included, so the guarantee doesn't depend on grants alone.
-- 3. Entries can only be attributed to the company in context (or to none,
--    for platform-wide actions).

GRANT INSERT ON audit_log TO expendi_business_app;
--> statement-breakpoint
CREATE FUNCTION audit_log_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
--> statement-breakpoint
-- Not FORCEd: the app role has no SELECT grant, so the policy below only
-- constrains its inserts, and the owner (ops, tests, the future staff audit
-- viewer) must still be able to read entries.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (
    organization_id IS NULL
    OR organization_id = (SELECT app_current_org_id())
  );
