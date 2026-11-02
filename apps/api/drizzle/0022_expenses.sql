CREATE TYPE "public"."etims_status" AS ENUM('attached', 'not_required', 'none');--> statement-breakpoint
CREATE TYPE "public"."expense_kind" AS ENUM('claim', 'float', 'company');--> statement-breakpoint
CREATE TYPE "public"."expense_source" AS ENUM('app', 'import');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('submitted', 'rejected', 'paying', 'paid', 'payout_failed', 'paid_outside', 'recorded');--> statement-breakpoint
CREATE TYPE "public"."overview_heading" AS ENUM('petty_cash', 'transactions', 'salaries', 'subscriptions');--> statement-breakpoint
CREATE TYPE "public"."receipt_file_kind" AS ENUM('photo', 'screenshot', 'sms_text');--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"kind" "expense_kind" NOT NULL,
	"overview_heading" "overview_heading" NOT NULL,
	"float_id" uuid,
	"paid_from_account" text,
	"category_id" uuid NOT NULL,
	"merchant" text NOT NULL,
	"amount_kes" bigint NOT NULL,
	"spent_on" date NOT NULL,
	"description" text,
	"source" "expense_source" DEFAULT 'app' NOT NULL,
	"status" "expense_status" NOT NULL,
	"mpesa_code" text,
	"etims_invoice_number" text,
	"etims_supplier_pin" text,
	"etims_qr_payload" text,
	"etims_status" "etims_status" DEFAULT 'none' NOT NULL,
	"extraction" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected_reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "expenses_amount_positive" CHECK ("expenses"."amount_kes" > 0),
	CONSTRAINT "expenses_codes_uppercase" CHECK ("expenses"."mpesa_code" = upper("expenses"."mpesa_code") AND "expenses"."etims_invoice_number" = upper("expenses"."etims_invoice_number")),
	CONSTRAINT "expenses_rejected_has_reason" CHECK (("expenses"."status" = 'rejected') = ("expenses"."rejected_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "receipt_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"expense_id" uuid,
	"bill_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"kind" "receipt_file_kind" NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_files_one_owner" CHECK ("receipt_files"."expense_id" IS NULL OR "receipt_files"."bill_id" IS NULL),
	CONSTRAINT "receipt_files_sha256_hex" CHECK ("receipt_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "receipt_files_byte_size_positive" CHECK ("receipt_files"."byte_size" > 0),
	CONSTRAINT "receipt_files_key_in_company_folder" CHECK (starts_with("receipt_files"."storage_key", 'org/' || "receipt_files"."organization_id"::text || '/'))
);
--> statement-breakpoint
-- Targets of the composite foreign keys below, so they come first.
ALTER TABLE "categories" ADD CONSTRAINT "categories_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_organization_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_expense_organization_fk" FOREIGN KEY ("expense_id","organization_id") REFERENCES "public"."expenses"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_mpesa_code_unique" ON "expenses" USING btree ("organization_id","mpesa_code") WHERE "expenses"."mpesa_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_etims_invoice_number_unique" ON "expenses" USING btree ("organization_id","etims_invoice_number") WHERE "expenses"."etims_invoice_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "expenses_organization_created_idx" ON "expenses" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "expenses_membership_created_idx" ON "expenses" USING btree ("membership_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_files_sha256_unique" ON "receipt_files" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_files_storage_key_unique" ON "receipt_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "receipt_files_expense_id_idx" ON "receipt_files" USING btree ("expense_id");