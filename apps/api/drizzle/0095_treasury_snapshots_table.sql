CREATE TABLE "treasury_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"assets_in_vault" bigint NOT NULL,
	"shares_in_vault" bigint NOT NULL,
	"user_apy" integer,
	"read_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_snapshots_organization_day_unique" UNIQUE("organization_id","snapshot_date"),
	CONSTRAINT "treasury_snapshots_amounts_not_negative" CHECK ("treasury_snapshots"."assets_in_vault" >= 0 AND "treasury_snapshots"."shares_in_vault" >= 0),
	CONSTRAINT "treasury_snapshots_apy_not_negative" CHECK ("treasury_snapshots"."user_apy" IS NULL OR "treasury_snapshots"."user_apy" >= 0)
);
--> statement-breakpoint
ALTER TABLE "treasury_snapshots" ADD CONSTRAINT "treasury_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;