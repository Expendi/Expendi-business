CREATE TYPE "public"."payee_kind" AS ENUM('employee', 'personnel', 'supplier', 'vendor', 'statutory');--> statement-breakpoint
CREATE TYPE "public"."payee_method" AS ENUM('mpesa_phone', 'mpesa_till', 'mpesa_paybill', 'bank', 'usdc', 'outside');--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'change_payee';--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "payee_kind" NOT NULL,
	"name" text NOT NULL,
	"membership_id" uuid,
	"method" "payee_method",
	"phone" text,
	"till_number" text,
	"paybill_number" text,
	"account_reference" text,
	"bank_code" text,
	"bank_account_number" text,
	"account_name" text,
	"usdc_address" text,
	"details_changed_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payees_name_present" CHECK (length(btrim("payees"."name")) > 0),
	CONSTRAINT "payees_employee_has_membership" CHECK (("payees"."kind" = 'employee') = ("payees"."membership_id" IS NOT NULL)),
	CONSTRAINT "payees_employee_methods" CHECK ("payees"."kind" <> 'employee' OR "payees"."method" IS NULL OR "payees"."method" IN ('mpesa_phone', 'bank', 'outside')),
	CONSTRAINT "payees_details_have_changed_at" CHECK ("payees"."method" IS NULL OR "payees"."method" = 'outside' OR "payees"."details_changed_at" IS NOT NULL),
	CONSTRAINT "payees_no_details" CHECK (("payees"."method" IS NOT NULL AND "payees"."method" <> 'outside') OR num_nonnulls("payees"."phone", "payees"."till_number", "payees"."paybill_number", "payees"."account_reference", "payees"."bank_code", "payees"."bank_account_number", "payees"."account_name", "payees"."usdc_address") = 0),
	CONSTRAINT "payees_mpesa_phone_details" CHECK ("payees"."method" IS DISTINCT FROM 'mpesa_phone' OR ("payees"."account_name" IS NOT NULL AND ("payees"."phone" IS NULL) = ("payees"."kind" = 'employee') AND ("payees"."phone" IS NULL OR "payees"."phone" ~ '^\+254[17][0-9]{8}$') AND num_nonnulls("payees"."till_number", "payees"."paybill_number", "payees"."account_reference", "payees"."bank_code", "payees"."bank_account_number", "payees"."usdc_address") = 0)),
	CONSTRAINT "payees_mpesa_till_details" CHECK ("payees"."method" IS DISTINCT FROM 'mpesa_till' OR ("payees"."account_name" IS NOT NULL AND "payees"."till_number" IS NOT NULL AND "payees"."till_number" ~ '^[0-9]{5,7}$' AND num_nonnulls("payees"."phone", "payees"."paybill_number", "payees"."account_reference", "payees"."bank_code", "payees"."bank_account_number", "payees"."usdc_address") = 0)),
	CONSTRAINT "payees_mpesa_paybill_details" CHECK ("payees"."method" IS DISTINCT FROM 'mpesa_paybill' OR ("payees"."account_name" IS NOT NULL AND "payees"."paybill_number" IS NOT NULL AND "payees"."paybill_number" ~ '^[0-9]{5,7}$' AND "payees"."account_reference" IS NOT NULL AND num_nonnulls("payees"."phone", "payees"."till_number", "payees"."bank_code", "payees"."bank_account_number", "payees"."usdc_address") = 0)),
	CONSTRAINT "payees_bank_details" CHECK ("payees"."method" IS DISTINCT FROM 'bank' OR ("payees"."account_name" IS NOT NULL AND "payees"."bank_code" IS NOT NULL AND "payees"."bank_account_number" IS NOT NULL AND num_nonnulls("payees"."phone", "payees"."till_number", "payees"."paybill_number", "payees"."account_reference", "payees"."usdc_address") = 0)),
	CONSTRAINT "payees_usdc_details" CHECK ("payees"."method" IS DISTINCT FROM 'usdc' OR ("payees"."usdc_address" IS NOT NULL AND "payees"."usdc_address" ~ '^0x[0-9a-f]{40}$' AND num_nonnulls("payees"."phone", "payees"."till_number", "payees"."paybill_number", "payees"."account_reference", "payees"."bank_code", "payees"."bank_account_number", "payees"."account_name") = 0))
);
--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payees_organization_id_idx" ON "payees" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payees_one_active_per_membership" ON "payees" USING btree ("organization_id","membership_id") WHERE "payees"."membership_id" IS NOT NULL AND NOT "payees"."archived";