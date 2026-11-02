CREATE TYPE "public"."recurring_pay_via" AS ENUM('expendi', 'outside');--> statement-breakpoint
CREATE TYPE "public"."recurring_schedule" AS ENUM('weekly', 'monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TABLE "recurring_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"overview_heading" "overview_heading" NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_kes" bigint,
	"schedule" "recurring_schedule" NOT NULL,
	"schedule_day" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"pay_via" "recurring_pay_via" DEFAULT 'expendi' NOT NULL,
	"reminder_days" integer DEFAULT 3 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_items_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "recurring_items_heading" CHECK ("recurring_items"."overview_heading" IN ('transactions', 'subscriptions', 'salaries')),
	CONSTRAINT "recurring_items_amount_positive" CHECK ("recurring_items"."amount_kes" IS NULL OR "recurring_items"."amount_kes" > 0),
	CONSTRAINT "recurring_items_schedule_day" CHECK ("recurring_items"."schedule_day" >= 1 AND "recurring_items"."schedule_day" <= CASE WHEN "recurring_items"."schedule" = 'weekly' THEN 7 ELSE 31 END),
	CONSTRAINT "recurring_items_reminder_days" CHECK ("recurring_items"."reminder_days" BETWEEN 0 AND 30),
	CONSTRAINT "recurring_items_ends_after_start" CHECK ("recurring_items"."ends_on" IS NULL OR "recurring_items"."ends_on" >= "recurring_items"."starts_on"),
	CONSTRAINT "recurring_items_next_due_in_schedule" CHECK ("recurring_items"."next_due_on" IS NULL OR ("recurring_items"."next_due_on" >= "recurring_items"."starts_on" AND ("recurring_items"."ends_on" IS NULL OR "recurring_items"."next_due_on" <= "recurring_items"."ends_on")))
);
--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_payee_organization_fk" FOREIGN KEY ("payee_id","organization_id") REFERENCES "public"."payees"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_category_organization_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_items_organization_id_idx" ON "recurring_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recurring_items_payee_id_idx" ON "recurring_items" USING btree ("payee_id");--> statement-breakpoint
CREATE INDEX "recurring_items_scheduled_idx" ON "recurring_items" USING btree ("next_due_on") WHERE "recurring_items"."active" AND "recurring_items"."next_due_on" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_recurring_item_organization_fk" FOREIGN KEY ("recurring_item_id","organization_id") REFERENCES "public"."recurring_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_recurring_item_outstanding_unique" ON "bills" USING btree ("recurring_item_id") WHERE "bills"."recurring_item_id" IS NOT NULL AND "bills"."status" IN ('upcoming', 'due', 'overdue', 'payout_failed', 'paying');