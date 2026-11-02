CREATE TYPE "public"."bill_currency" AS ENUM('kes', 'usd');--> statement-breakpoint
ALTER TABLE "bills" DROP CONSTRAINT "bills_fixed_has_amount";--> statement-breakpoint
ALTER TABLE "bills" DROP CONSTRAINT "bills_settled_has_amount";--> statement-breakpoint
ALTER TABLE "recurring_items" DROP CONSTRAINT "recurring_items_salary_shape";--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "currency" "bill_currency" DEFAULT 'kes' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "amount_usdc" bigint;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "currency" "bill_currency" DEFAULT 'kes' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "amount_usdc" bigint;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_amount_usdc_positive" CHECK ("bills"."amount_usdc" IS NULL OR "bills"."amount_usdc" > 0);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_amount_in_currency" CHECK (("bills"."currency" = 'kes' AND "bills"."amount_usdc" IS NULL) OR ("bills"."currency" = 'usd' AND "bills"."amount_kes" IS NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_payroll_in_kes" CHECK ("bills"."payroll_run_id" IS NULL OR "bills"."currency" = 'kes');--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_fixed_has_amount" CHECK ("bills"."variable" OR "bills"."amount_kes" IS NOT NULL OR "bills"."amount_usdc" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_settled_has_amount" CHECK ("bills"."status" NOT IN ('paying', 'paid', 'paid_outside') OR "bills"."amount_kes" IS NOT NULL OR "bills"."amount_usdc" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_amount_usdc_positive" CHECK ("recurring_items"."amount_usdc" IS NULL OR "recurring_items"."amount_usdc" > 0);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_amount_in_currency" CHECK (("recurring_items"."currency" = 'kes' AND "recurring_items"."amount_usdc" IS NULL) OR ("recurring_items"."currency" = 'usd' AND "recurring_items"."amount_kes" IS NULL));--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_salary_shape" CHECK ("recurring_items"."overview_heading" <> 'salaries' OR ("recurring_items"."amount_kes" IS NOT NULL AND "recurring_items"."currency" = 'kes' AND "recurring_items"."schedule" = 'monthly' AND "recurring_items"."pay_via" = 'expendi'));