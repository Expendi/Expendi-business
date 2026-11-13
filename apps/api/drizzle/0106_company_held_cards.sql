CREATE TYPE "public"."card_purchase_review_state" AS ENUM('needs_review', 'one_off', 'not_recognised');--> statement-breakpoint
ALTER TYPE "public"."bill_status" ADD VALUE 'paid_by_card' BEFORE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."recurring_pay_via" ADD VALUE 'card';--> statement-breakpoint
CREATE TABLE "card_merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"merchant_key" text NOT NULL,
	"descriptor" text NOT NULL,
	"recurring_item_id" uuid,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_merchants_blocked_unlinked" CHECK (NOT ("card_merchants"."blocked" AND "card_merchants"."recurring_item_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "card_simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recurring_item_id" uuid NOT NULL,
	"bill_id" uuid,
	"lithic_transaction_token" text NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"merchant_key" text NOT NULL,
	"run_by_staff" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_simulations_amount_positive" CHECK ("card_simulations"."amount_usd_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "bills" DROP CONSTRAINT "bills_settled_has_amount";--> statement-breakpoint
ALTER TABLE "bills" DROP CONSTRAINT "bills_paid_has_dates";--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_card_recorded";--> statement-breakpoint
ALTER TABLE "card_purchases" ALTER COLUMN "membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "cardholder_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "card_purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "card_declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "card_decline_reason" text;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD COLUMN "merchant_key" text;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD COLUMN "recurring_item_id" uuid;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD COLUMN "review_state" "card_purchase_review_state";--> statement-breakpoint
ALTER TABLE "card_purchases" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "company_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "card_id" uuid;--> statement-breakpoint
ALTER TABLE "card_merchants" ADD CONSTRAINT "card_merchants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_merchants" ADD CONSTRAINT "card_merchants_card_organization_fk" FOREIGN KEY ("card_id","organization_id") REFERENCES "public"."cards"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_merchants" ADD CONSTRAINT "card_merchants_recurring_item_organization_fk" FOREIGN KEY ("recurring_item_id","organization_id") REFERENCES "public"."recurring_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_simulations" ADD CONSTRAINT "card_simulations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_simulations" ADD CONSTRAINT "card_simulations_run_by_staff_staff_users_id_fk" FOREIGN KEY ("run_by_staff") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_simulations" ADD CONSTRAINT "card_simulations_recurring_item_organization_fk" FOREIGN KEY ("recurring_item_id","organization_id") REFERENCES "public"."recurring_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_simulations" ADD CONSTRAINT "card_simulations_bill_organization_fk" FOREIGN KEY ("bill_id","organization_id") REFERENCES "public"."bills"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_merchants_card_merchant_unique" ON "card_merchants" USING btree ("card_id","merchant_key");--> statement-breakpoint
CREATE INDEX "card_merchants_recurring_item_idx" ON "card_merchants" USING btree ("recurring_item_id") WHERE "card_merchants"."recurring_item_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "card_simulations_transaction_token_unique" ON "card_simulations" USING btree ("lithic_transaction_token");--> statement-breakpoint
CREATE INDEX "card_simulations_bill_idx" ON "card_simulations" USING btree ("bill_id");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_card_purchase_organization_fk" FOREIGN KEY ("card_purchase_id","organization_id") REFERENCES "public"."card_purchases"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_recurring_item_organization_fk" FOREIGN KEY ("recurring_item_id","organization_id") REFERENCES "public"."recurring_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_bill_organization_fk" FOREIGN KEY ("bill_id","organization_id") REFERENCES "public"."bills"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_card_organization_fk" FOREIGN KEY ("card_id","organization_id") REFERENCES "public"."cards"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_card_purchase_id_unique" ON "bills" USING btree ("card_purchase_id") WHERE "bills"."card_purchase_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "card_purchases_bill_unique" ON "card_purchases" USING btree ("bill_id") WHERE "card_purchases"."bill_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "card_purchases_needs_review_idx" ON "card_purchases" USING btree ("organization_id","authorized_at") WHERE "card_purchases"."review_state" = 'needs_review';--> statement-breakpoint
CREATE INDEX "recurring_items_card_id_idx" ON "recurring_items" USING btree ("card_id") WHERE "recurring_items"."card_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_paid_by_card_has_purchase" CHECK (("bills"."status"::text = 'paid_by_card') = ("bills"."card_purchase_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_settled_has_amount" CHECK ("bills"."status"::text NOT IN ('paying', 'paid', 'paid_outside', 'paid_by_card') OR "bills"."amount_kes" IS NOT NULL OR "bills"."amount_usdc" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_paid_has_dates" CHECK (("bills"."status"::text IN ('paid', 'paid_outside', 'paid_by_card')) = ("bills"."paid_on" IS NOT NULL) AND ("bills"."status"::text IN ('paid', 'paid_outside', 'paid_by_card')) = ("bills"."paid_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_card_recorded" CHECK ("expenses"."kind"::text <> 'card' OR ("expenses"."status" = 'recorded' AND "expenses"."paid_from_account_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_match_on_company_held" CHECK ("card_purchases"."membership_id" IS NULL OR ("card_purchases"."recurring_item_id" IS NULL AND "card_purchases"."bill_id" IS NULL AND "card_purchases"."review_state" IS NULL));--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_linked_or_reviewed" CHECK ("card_purchases"."recurring_item_id" IS NULL OR "card_purchases"."review_state" IS NULL);--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_bill_is_linked" CHECK ("card_purchases"."bill_id" IS NULL OR "card_purchases"."recurring_item_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_reviewed_recorded" CHECK (("card_purchases"."reviewed_by" IS NULL) = ("card_purchases"."reviewed_at" IS NULL));--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_holder_unless_company_held" CHECK ("cards"."company_held" = ("cards"."cardholder_id" IS NULL) AND "cards"."company_held" = ("cards"."membership_id" IS NULL));--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_card_pays_by_card" CHECK (("recurring_items"."pay_via"::text = 'card') = ("recurring_items"."card_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_card_in_usd" CHECK ("recurring_items"."pay_via"::text <> 'card' OR "recurring_items"."currency" = 'usd');