CREATE TYPE "public"."paid_from_account_kind" AS ENUM('bank', 'card', 'mobile_money', 'cash', 'other');--> statement-breakpoint
CREATE TABLE "paid_from_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "paid_from_account_kind" NOT NULL,
	"accounting_account_id" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_from_accounts_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "paid_from_accounts_name_present" CHECK (length(btrim("paid_from_accounts"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_from_account_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "no_receipt_reason" text;--> statement-breakpoint
ALTER TABLE "paid_from_accounts" ADD CONSTRAINT "paid_from_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_from_accounts_active_name_unique" ON "paid_from_accounts" USING btree ("organization_id",lower("name")) WHERE NOT "paid_from_accounts"."archived";--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_from_account_organization_fk" FOREIGN KEY ("paid_from_account_id","organization_id") REFERENCES "public"."paid_from_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_bill_organization_fk" FOREIGN KEY ("bill_id","organization_id") REFERENCES "public"."bills"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_bill_id_unique" ON "expenses" USING btree ("bill_id") WHERE "expenses"."bill_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "expenses_organization_kind_spent_on_idx" ON "expenses" USING btree ("organization_id","kind","spent_on");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_recorded" CHECK ("expenses"."kind" <> 'company' OR "expenses"."status" = 'recorded');--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_links" CHECK ("expenses"."kind" = 'company' OR ("expenses"."paid_from_account_id" IS NULL AND "expenses"."bill_id" IS NULL));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_no_receipt_reason" CHECK ("expenses"."no_receipt_reason" IS NULL OR ("expenses"."kind" <> 'claim' AND length(btrim("expenses"."no_receipt_reason")) > 0));