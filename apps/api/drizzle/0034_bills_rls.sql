-- Bills (spec §6.20, §8): company-scoped and admins only (spec §4), like
-- payroll_runs. The routes admit admins only; this makes an employee's
-- transaction see no bills even if a route forgets. Payroll bills (T38) sit
-- in this table too, so salaries stay private here as well. Nothing is
-- deleted: a bill is cancelled, with a reason.
GRANT SELECT, INSERT, UPDATE ON bills TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bills_admins ON bills FOR ALL
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint

-- The daily status job (spec §6.20) moves every company's bills forward by
-- date: upcoming → due → overdue, given today's date in Nairobi. It is one
-- statement across companies, so it runs as this SECURITY DEFINER function
-- (owned by the migration role) rather than as a company admin. These two
-- policies let the owner read and update bills; the function's body is the
-- only thing that uses them, and the app role is unaffected.
--
-- Only `upcoming` and `due` bills move, and only forward, so running it
-- twice, or late, is safe. Bills being paid, paid, failed, paid outside or
-- cancelled are never touched. A status tick isn't an audited event: it
-- follows from the due date alone.
CREATE POLICY bills_owner_reads ON bills FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY bills_owner_advances ON bills FOR UPDATE TO CURRENT_USER
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION advance_bill_statuses(today date)
  RETURNS TABLE (bill_id uuid, organization_id uuid, status bill_status)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE bills AS b
    SET status = CASE WHEN b.due_on < today THEN 'overdue'::bill_status ELSE 'due'::bill_status END,
        updated_at = now()
    WHERE (b.status = 'upcoming' AND b.due_on <= today)
       OR (b.status = 'due' AND b.due_on < today)
    RETURNING b.id, b.organization_id, b.status
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION advance_bill_statuses(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION advance_bill_statuses(date) TO expendi_business_app;
--> statement-breakpoint

-- A bill's invoice and proof of payment are as private as the bill: only
-- admins see a receipt file once it's on a bill, and only they can put one
-- there. Pending files and claim receipts keep the company-wide policies.
DROP POLICY receipt_files_select ON receipt_files;
--> statement-breakpoint
CREATE POLICY receipt_files_select ON receipt_files FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (bill_id IS NULL OR (SELECT app_current_role()) = 'admin')
  );
--> statement-breakpoint
DROP POLICY receipt_files_update ON receipt_files;
--> statement-breakpoint
CREATE POLICY receipt_files_update ON receipt_files FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (bill_id IS NULL OR (SELECT app_current_role()) = 'admin')
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (bill_id IS NULL OR (SELECT app_current_role()) = 'admin')
  );
