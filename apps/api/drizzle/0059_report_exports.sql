CREATE TABLE "report_export_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"membership_id" uuid,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_export_links_token_hash" CHECK ("report_export_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "report_export_links_emailed" CHECK ("report_export_links"."emailed_at" IS NULL OR "report_export_links"."membership_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"month" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"monthly" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"recipients" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_exports_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "report_exports_month" CHECK ("report_exports"."month" ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "report_exports_creator" CHECK (("report_exports"."created_by" IS NULL) = "report_exports"."monthly"),
	CONSTRAINT "report_exports_recipients" CHECK ("report_exports"."monthly" OR cardinality("report_exports"."recipients") = 0)
);
--> statement-breakpoint
ALTER TABLE "report_export_links" ADD CONSTRAINT "report_export_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_export_links" ADD CONSTRAINT "report_export_links_export_organization_fk" FOREIGN KEY ("export_id","organization_id") REFERENCES "public"."report_exports"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_export_links" ADD CONSTRAINT "report_export_links_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_export_links_token_hash_unique" ON "report_export_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "report_export_links_recipient_unique" ON "report_export_links" USING btree ("export_id","membership_id") WHERE "report_export_links"."membership_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "report_exports_monthly_unique" ON "report_exports" USING btree ("organization_id","month") WHERE "report_exports"."monthly";--> statement-breakpoint
CREATE INDEX "report_exports_organization_created_idx" ON "report_exports" USING btree ("organization_id","created_at");