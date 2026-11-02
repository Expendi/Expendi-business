CREATE TABLE "import_rows" (
	"organization_id" uuid NOT NULL,
	"row_hash" text NOT NULL,
	"run_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "import_rows_company_hash_unique" UNIQUE("organization_id","row_hash")
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"kind" text NOT NULL,
	"column_mapping" jsonb NOT NULL,
	"rows_total" integer NOT NULL,
	"rows_imported" integer NOT NULL,
	"rows_skipped" integer NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "import_runs_counts" CHECK ("import_runs"."rows_total" = "import_runs"."rows_imported" + "import_runs"."rows_skipped" AND "import_runs"."rows_imported" >= 0 AND "import_runs"."rows_skipped" >= 0)
);
--> statement-breakpoint
ALTER TABLE "floats" ADD COLUMN "imported_issued_kes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "floats" ADD COLUMN "imported_spent_kes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_run_id_organization_id_import_runs_id_organization_id_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."import_runs"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floats" ADD CONSTRAINT "floats_imported_totals" CHECK ("floats"."imported_issued_kes" >= "floats"."imported_spent_kes" AND "floats"."imported_spent_kes" >= 0);
--> statement-breakpoint
GRANT SELECT, INSERT ON import_runs, import_rows TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_runs_scope ON import_runs FOR ALL TO expendi_business_app
  USING (organization_id = (SELECT app_current_org_id()) AND nullif(current_setting('app.import_staff_id', true), '') IS NOT NULL)
  WITH CHECK (organization_id = (SELECT app_current_org_id()) AND staff_user_id::text = current_setting('app.import_staff_id', true));
--> statement-breakpoint
CREATE POLICY import_rows_scope ON import_rows FOR ALL TO expendi_business_app
  USING (organization_id = (SELECT app_current_org_id()) AND nullif(current_setting('app.import_staff_id', true), '') IS NOT NULL)
  WITH CHECK (organization_id = (SELECT app_current_org_id()) AND nullif(current_setting('app.import_staff_id', true), '') IS NOT NULL);
