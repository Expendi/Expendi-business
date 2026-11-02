-- IDs only, like recurring_items_owed_a_bill. Existing owner-read policies
-- cover bills and recurring items. Actual reminders run in an admin scope.
CREATE POLICY payroll_runs_owner_reads ON payroll_runs FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION reminder_companies()
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT b.organization_id FROM bills b
      WHERE b.status IN ('upcoming', 'due', 'overdue', 'payout_failed')
    UNION
    SELECT p.organization_id FROM payroll_runs p WHERE p.status = 'draft'
    UNION
    SELECT r.organization_id FROM recurring_items r
      WHERE r.active AND r.overview_heading = 'salaries' AND r.next_due_on IS NOT NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reminder_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reminder_companies() TO expendi_business_app;
