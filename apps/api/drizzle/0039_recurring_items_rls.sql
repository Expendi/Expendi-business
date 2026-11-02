-- Recurring payments (spec §6.20, §8): company-scoped and admins only (spec
-- §4), like bills. Salaries are recurring items too (T38), so they stay
-- private here as well. Nothing is deleted: an item is paused or ended.
GRANT SELECT, INSERT, UPDATE ON recurring_items TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE recurring_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recurring_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recurring_items_admins ON recurring_items FOR ALL
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint

-- The daily recurring-bills job (spec §6.20) looks across companies for
-- items that are owed a bill: active, not ended, not salaries (payroll
-- drafts those, T38), paid to a payee who isn't archived (an archived payee
-- gets no new bills), and with no bill still owed. It returns IDs only; each
-- bill is then created inside that company's scope, where the schedule is
-- worked out. This policy lets the function's owner read the items, SELECT
-- only, and the same for payees; it reads bills through bills_owner_reads
-- (0034). The app role is unaffected.
CREATE POLICY recurring_items_owner_reads ON recurring_items FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY payees_owner_reads ON payees FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION recurring_items_owed_a_bill(max_rows integer)
  RETURNS TABLE (recurring_item_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT r.id, r.organization_id
    FROM recurring_items r
    JOIN payees p ON p.id = r.payee_id
    WHERE r.active
      AND NOT p.archived
      AND r.next_due_on IS NOT NULL
      AND r.overview_heading <> 'salaries'
      AND NOT EXISTS (
        SELECT 1 FROM bills b
        WHERE b.recurring_item_id = r.id
          AND b.status IN ('upcoming', 'due', 'overdue', 'payout_failed', 'paying')
      )
    ORDER BY r.next_due_on, r.id
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION recurring_items_owed_a_bill(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION recurring_items_owed_a_bill(integer) TO expendi_business_app;
