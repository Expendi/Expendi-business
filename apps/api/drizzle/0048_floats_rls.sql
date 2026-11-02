-- Petty cash floats (spec §4, §6.22, §8): company-scoped, and private to
-- whoever holds them. Admins see every float; anyone else sees only the
-- floats they hold (app_current_membership_id(), 0045), so an employee's
-- transaction can't read a colleague's float or its movements even if a
-- route forgets to filter. Scopes with no role are the payout engine and
-- its jobs (fund, sync, reconcile, confirm-onchain, staff resolution): they
-- act for no person, read the company's floats, and move an issue or
-- top-up along with its payout.
--
-- Only admins open, top up, record returns and close. The holder's UPDATE
-- USING lets their own transaction lock their float (SELECT ... FOR UPDATE
-- checks UPDATE's USING) while recording spending; UPDATE's WITH CHECK
-- still stops them changing it.
--
-- Nothing is deleted. Column grants keep a movement's float, type and
-- amount fixed once written: only its status, latest payout and paid time
-- change, and a float only closes.
GRANT SELECT, INSERT ON floats TO expendi_business_app;
--> statement-breakpoint
GRANT UPDATE (status, closed_at, closed_by, updated_at) ON floats TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE floats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE floats FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY floats_select ON floats FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
      OR membership_id = (SELECT app_current_membership_id())
    )
  );
--> statement-breakpoint
CREATE POLICY floats_insert ON floats FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY floats_update ON floats FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) = 'admin'
      OR membership_id = (SELECT app_current_membership_id())
    )
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint

GRANT SELECT, INSERT ON float_movements TO expendi_business_app;
--> statement-breakpoint
GRANT UPDATE (status, payout_id, paid_at, updated_at) ON float_movements TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE float_movements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE float_movements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY float_movements_select ON float_movements FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
      OR float_id IN (
        SELECT f.id FROM floats f
        WHERE f.membership_id = (SELECT app_current_membership_id())
      )
    )
  );
--> statement-breakpoint
CREATE POLICY float_movements_insert ON float_movements FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY float_movements_update ON float_movements FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
