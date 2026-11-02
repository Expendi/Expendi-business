CREATE TYPE "public"."bill_status" AS ENUM('upcoming', 'due', 'overdue', 'paying', 'paid', 'payout_failed', 'paid_outside', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."bill_file_role" AS ENUM('invoice', 'proof');--> statement-breakpoint
ALTER TYPE "public"."receipt_file_kind" ADD VALUE 'pdf';--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"recurring_item_id" uuid,
	"payroll_run_id" uuid,
	"overview_heading" "overview_heading" NOT NULL,
	"category_id" uuid NOT NULL,
	"variable" boolean DEFAULT false NOT NULL,
	"amount_kes" bigint,
	"reference" text,
	"notes" text,
	"due_on" date NOT NULL,
	"status" "bill_status" NOT NULL,
	"adjustment_reason" text,
	"paid_on" date,
	"paid_at" timestamp with time zone,
	"marked_paid_by" uuid,
	"paid_outside_note" text,
	"cancelled_reason" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"payout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "bills_heading" CHECK ("bills"."overview_heading" <> 'petty_cash' AND ("bills"."payroll_run_id" IS NULL OR "bills"."overview_heading" = 'salaries')),
	CONSTRAINT "bills_amount_positive" CHECK ("bills"."amount_kes" IS NULL OR "bills"."amount_kes" > 0),
	CONSTRAINT "bills_fixed_has_amount" CHECK ("bills"."variable" OR "bills"."amount_kes" IS NOT NULL),
	CONSTRAINT "bills_settled_has_amount" CHECK ("bills"."status" NOT IN ('paying', 'paid', 'paid_outside') OR "bills"."amount_kes" IS NOT NULL),
	CONSTRAINT "bills_paid_has_dates" CHECK (("bills"."status" IN ('paid', 'paid_outside')) = ("bills"."paid_on" IS NOT NULL) AND ("bills"."status" IN ('paid', 'paid_outside')) = ("bills"."paid_at" IS NOT NULL)),
	CONSTRAINT "bills_paid_outside_recorded" CHECK (("bills"."status" = 'paid_outside') = ("bills"."marked_paid_by" IS NOT NULL) AND ("bills"."paid_outside_note" IS NULL OR "bills"."status" = 'paid_outside')),
	CONSTRAINT "bills_cancelled_recorded" CHECK (("bills"."status" = 'cancelled') = ("bills"."cancelled_reason" IS NOT NULL) AND ("bills"."status" = 'cancelled') = ("bills"."cancelled_by" IS NOT NULL) AND ("bills"."status" = 'cancelled') = ("bills"."cancelled_at" IS NOT NULL) AND ("bills"."cancelled_reason" IS NULL OR length(btrim("bills"."cancelled_reason")) > 0)),
	CONSTRAINT "bills_through_expendi_has_payout" CHECK ("bills"."status" NOT IN ('paying', 'paid', 'payout_failed') OR "bills"."payout_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "receipt_files" ADD COLUMN "bill_role" "bill_file_role";--> statement-breakpoint
-- The composite foreign keys below reference these, so they come first.
ALTER TABLE "payees" ADD CONSTRAINT "payees_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_marked_paid_by_users_id_fk" FOREIGN KEY ("marked_paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_payee_organization_fk" FOREIGN KEY ("payee_id","organization_id") REFERENCES "public"."payees"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_category_organization_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_payroll_run_organization_fk" FOREIGN KEY ("payroll_run_id","organization_id") REFERENCES "public"."payroll_runs"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_payout_organization_fk" FOREIGN KEY ("payout_id","organization_id") REFERENCES "public"."payouts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_payout_id_unique" ON "bills" USING btree ("payout_id") WHERE "bills"."payout_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bills_organization_due_on_idx" ON "bills" USING btree ("organization_id","due_on");--> statement-breakpoint
CREATE INDEX "bills_payee_id_idx" ON "bills" USING btree ("payee_id");--> statement-breakpoint
CREATE INDEX "bills_dated_due_on_idx" ON "bills" USING btree ("due_on") WHERE "bills"."status" IN ('upcoming', 'due');--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_bill_organization_fk" FOREIGN KEY ("bill_id","organization_id") REFERENCES "public"."bills"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_files_bill_id_idx" ON "receipt_files" USING btree ("bill_id");--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_bill_role" CHECK (("receipt_files"."bill_id" IS NULL) = ("receipt_files"."bill_role" IS NULL));--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_pdf_not_on_expense" CHECK ("receipt_files"."content_type" <> 'application/pdf' OR "receipt_files"."expense_id" IS NULL);