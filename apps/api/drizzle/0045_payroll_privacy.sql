-- Payroll privacy (spec §4, §6.21): only admins see salaries and payroll
-- runs; each person sees only their own salary payments.
--
-- Salary recurring_items, payroll bills and payroll_runs are already
-- admins-only (0010, 0034, 0039). This adds the one exception, a person's
-- own salary payments, and closes the Phase 1 gap where any company scope
-- could read payroll payouts.

-- The caller's active membership in the company in context, or NULL.
-- memberships are readable company-wide, so this runs as the caller.
CREATE FUNCTION app_current_membership_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT m.id FROM memberships m
    WHERE m.organization_id = app_current_org_id()
      AND m.user_id = app_current_user_id()
      AND m.status = 'active'
  $$;
--> statement-breakpoint

-- bills: a person's own salary payments once their run is approved (being
-- paid, paid, or failed and waiting for a retry), whatever their role.
-- Drafts, people left out and everyone else's pay stay with the admins
-- (bills_admins). Policies are permissive, so this widens SELECT only.
CREATE POLICY bills_own_salary_payments ON bills FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND payroll_run_id IS NOT NULL
    AND status IN ('paying', 'paid', 'payout_failed')
    AND payee_id IN (
      SELECT p.id FROM payees p
      WHERE p.membership_id = (SELECT app_current_membership_id())
    )
  );
--> statement-breakpoint

-- payouts: a payout that's part of a payroll run is someone's salary. A
-- request always carries its caller's role (tenant middleware), so in a
-- request only an admin sees it, or the person it pays (through their own
-- salary bill, which bills' policies above already limit to them). Scopes
-- with no role are the payout engine and its jobs (fund, sync, reconcile,
-- retry, confirm-onchain, the balance held back for payouts): they act for
-- no person and keep seeing every payout of the company in context. The
-- owner's definer lookups use payouts_owner_reads (0012), unchanged.
DROP POLICY payouts_select ON payouts;
--> statement-breakpoint
CREATE POLICY payouts_select ON payouts FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      payroll_run_id IS NULL
      OR (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
      OR (
        subject_type = 'bill'
        AND subject_id IN (
          SELECT b.id FROM bills b
          JOIN payees p ON p.id = b.payee_id
          WHERE b.payroll_run_id = payouts.payroll_run_id
            AND p.membership_id = (SELECT app_current_membership_id())
        )
      )
    )
  );
--> statement-breakpoint
DROP POLICY payouts_insert ON payouts;
--> statement-breakpoint
CREATE POLICY payouts_insert ON payouts FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      payroll_run_id IS NULL
      OR (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint
DROP POLICY payouts_update ON payouts;
--> statement-breakpoint
CREATE POLICY payouts_update ON payouts FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      payroll_run_id IS NULL
      OR (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      payroll_run_id IS NULL
      OR (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint

-- The payroll-drafts job (spec §6.21) looks across companies for pay dates
-- that are `lead_days` or fewer Nairobi days away (`today` is the Nairobi
-- date) with an active salary not yet drafted: its `next_due_on`. It
-- returns IDs and dates only; each run is then drafted inside that
-- company's scope. Ended salaries have no next_due_on; paused ones and
-- archived payees are left out. It reads recurring_items and payees
-- through their owner-read policies (0039). The app role is unaffected.
CREATE FUNCTION salary_pay_dates_to_draft(today date, lead_days integer, max_rows integer)
  RETURNS TABLE (organization_id uuid, pay_date date)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT r.organization_id, r.next_due_on
    FROM recurring_items r
    JOIN payees p ON p.id = r.payee_id
    WHERE r.overview_heading = 'salaries'
      AND r.active
      AND NOT p.archived
      AND r.next_due_on IS NOT NULL
      AND r.next_due_on <= today + lead_days
    ORDER BY r.next_due_on, r.organization_id
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION salary_pay_dates_to_draft(date, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION salary_pay_dates_to_draft(date, integer, integer) TO expendi_business_app;
