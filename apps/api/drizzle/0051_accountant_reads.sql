-- Accountants see everything in their company, salaries and payroll runs
-- included, and change nothing (spec §4, §6.14; Dennis, 2026-11-02). The
-- tables that were admins-only become readable by accountants too; inserts
-- and updates stay with admins. No DELETE is granted on any of them.

-- bills, recurring_items, payroll_runs: each admins-only policy (0034, 0039,
-- 0010) splits into a read policy for admins and accountants and admin-only
-- insert and update policies. A person's own salary payments stay readable
-- through bills_own_salary_payments (0045).
DROP POLICY bills_admins ON bills;
--> statement-breakpoint
CREATE POLICY bills_select ON bills FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IN ('admin', 'accountant')
  );
--> statement-breakpoint
CREATE POLICY bills_insert ON bills FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY bills_update ON bills FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
DROP POLICY recurring_items_admins ON recurring_items;
--> statement-breakpoint
CREATE POLICY recurring_items_select ON recurring_items FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IN ('admin', 'accountant')
  );
--> statement-breakpoint
CREATE POLICY recurring_items_insert ON recurring_items FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY recurring_items_update ON recurring_items FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
DROP POLICY payroll_runs_admins ON payroll_runs;
--> statement-breakpoint
CREATE POLICY payroll_runs_select ON payroll_runs FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IN ('admin', 'accountant')
  );
--> statement-breakpoint
CREATE POLICY payroll_runs_insert ON payroll_runs FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY payroll_runs_update ON payroll_runs FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint

-- receipt_files: a bill's invoice and proof of payment (0034). Only admins
-- still attach or change them.
DROP POLICY receipt_files_select ON receipt_files;
--> statement-breakpoint
CREATE POLICY receipt_files_select ON receipt_files FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      bill_id IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint

-- payouts: a payroll payout is someone's salary (0045). Accountants read
-- them; inserts and updates keep 0045's rule.
DROP POLICY payouts_select ON payouts;
--> statement-breakpoint
CREATE POLICY payouts_select ON payouts FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      payroll_run_id IS NULL
      OR (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
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

-- floats, float_movements (0048): admins see every float and holders their
-- own. Accountants read them all through policies of their own, so the
-- holders' rules stay in one place.
CREATE POLICY floats_accountants_select ON floats FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'accountant'
  );
--> statement-breakpoint
CREATE POLICY float_movements_accountants_select ON float_movements FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'accountant'
  );
