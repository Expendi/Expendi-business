ALTER TABLE "import_runs" ALTER COLUMN "staff_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_runs" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_one_actor" CHECK (("import_runs"."staff_user_id" IS NOT NULL) <> ("import_runs"."membership_id" IS NOT NULL));
--> statement-breakpoint
CREATE POLICY import_runs_member_select ON import_runs FOR SELECT TO expendi_business_app
  USING (organization_id = (SELECT app_current_org_id()) AND (SELECT app_current_role()) = 'admin'
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = import_runs.organization_id
      AND m.user_id = (SELECT app_current_user_id()) AND m.role = 'admin' AND m.status = 'active'));
--> statement-breakpoint
CREATE POLICY import_runs_member_insert ON import_runs FOR INSERT TO expendi_business_app
  WITH CHECK (organization_id = (SELECT app_current_org_id()) AND (SELECT app_current_role()) = 'admin'
    AND staff_user_id IS NULL AND kind IN ('history', 'bill')
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.id = import_runs.membership_id
      AND m.organization_id = import_runs.organization_id AND m.user_id = (SELECT app_current_user_id())
      AND m.role = 'admin' AND m.status = 'active'));
--> statement-breakpoint
CREATE POLICY import_rows_member_select ON import_rows FOR SELECT TO expendi_business_app
  USING (organization_id = (SELECT app_current_org_id()) AND (SELECT app_current_role()) = 'admin'
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = import_rows.organization_id
      AND m.user_id = (SELECT app_current_user_id()) AND m.role = 'admin' AND m.status = 'active'));
--> statement-breakpoint
CREATE POLICY import_rows_member_insert ON import_rows FOR INSERT TO expendi_business_app
  WITH CHECK (organization_id = (SELECT app_current_org_id()) AND (SELECT app_current_role()) = 'admin'
    AND EXISTS (SELECT 1 FROM import_runs r JOIN memberships m ON m.id = r.membership_id AND m.organization_id = r.organization_id
      WHERE r.id = import_rows.run_id AND r.organization_id = import_rows.organization_id
        AND r.staff_user_id IS NULL AND m.user_id = (SELECT app_current_user_id()) AND m.role = 'admin' AND m.status = 'active'));
