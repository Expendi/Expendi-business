CREATE TYPE "public"."card_purchase_kind" AS ENUM('purchase', 'refund');--> statement-breakpoint
CREATE TYPE "public"."card_purchase_status" AS ENUM('pending', 'settled', 'voided', 'expired', 'declined');--> statement-breakpoint
CREATE TYPE "public"."card_state" AS ENUM('open', 'frozen', 'closed');--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'manage_cards';--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'load_card_balance';--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'reveal_card';--> statement-breakpoint
ALTER TYPE "public"."expense_kind" ADD VALUE 'card';--> statement-breakpoint
CREATE TABLE "card_loads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"amount_kes" bigint NOT NULL,
	"usd_kes_rate" text NOT NULL,
	"simulated" boolean DEFAULT true NOT NULL,
	"loaded_by" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_loads_amount_positive" CHECK ("card_loads"."amount_usd_cents" > 0),
	CONSTRAINT "card_loads_kes_positive" CHECK ("card_loads"."amount_kes" > 0),
	CONSTRAINT "card_loads_simulated" CHECK ("card_loads"."simulated")
);
--> statement-breakpoint
CREATE TABLE "card_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"kra_pin" text NOT NULL,
	"address_line1" text NOT NULL,
	"city" text NOT NULL,
	"postal_code" text NOT NULL,
	"phone" text NOT NULL,
	"contact_first_name" text NOT NULL,
	"contact_last_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text NOT NULL,
	"lithic_account_holder_token" text NOT NULL,
	"lithic_account_token" text NOT NULL,
	"paid_from_account_id" uuid NOT NULL,
	"turned_on_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"lithic_transaction_token" text NOT NULL,
	"kind" "card_purchase_kind" DEFAULT 'purchase' NOT NULL,
	"status" "card_purchase_status" NOT NULL,
	"merchant" text NOT NULL,
	"mcc" text NOT NULL,
	"merchant_city" text,
	"merchant_country" text,
	"hold_usd_cents" bigint DEFAULT 0 NOT NULL,
	"settled_usd_cents" bigint DEFAULT 0 NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"decline_reason" text,
	"category_id" uuid NOT NULL,
	"usd_kes_rate" text,
	"expense_id" uuid,
	"changed_after_expense_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_purchases_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "card_purchases_hold_not_negative" CHECK ("card_purchases"."hold_usd_cents" >= 0),
	CONSTRAINT "card_purchases_settled_not_negative" CHECK ("card_purchases"."settled_usd_cents" >= 0),
	CONSTRAINT "card_purchases_refund_settled" CHECK ("card_purchases"."kind" <> 'refund' OR "card_purchases"."status" = 'settled'),
	CONSTRAINT "card_purchases_expense_has_rate" CHECK (("card_purchases"."expense_id" IS NULL) = ("card_purchases"."usd_kes_rate" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "cardholders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"lithic_account_holder_token" text NOT NULL,
	"lithic_account_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cardholders_id_organization_id_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cardholder_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"lithic_card_token" text NOT NULL,
	"nickname" text NOT NULL,
	"last_four" text NOT NULL,
	"state" "card_state" DEFAULT 'open' NOT NULL,
	"monthly_limit_usd_cents" bigint NOT NULL,
	"default_category_id" uuid NOT NULL,
	"issued_by" uuid NOT NULL,
	"close_requested_at" timestamp with time zone,
	"close_attempts" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "cards_monthly_limit_positive" CHECK ("cards"."monthly_limit_usd_cents" > 0),
	CONSTRAINT "cards_closed_has_date" CHECK (("cards"."state" = 'closed') = ("cards"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_company_links";--> statement-breakpoint
ALTER TABLE "receipt_files" ADD COLUMN "card_purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "card_loads" ADD CONSTRAINT "card_loads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_loads" ADD CONSTRAINT "card_loads_loaded_by_users_id_fk" FOREIGN KEY ("loaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_programs" ADD CONSTRAINT "card_programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_programs" ADD CONSTRAINT "card_programs_turned_on_by_users_id_fk" FOREIGN KEY ("turned_on_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_programs" ADD CONSTRAINT "card_programs_paid_from_account_organization_fk" FOREIGN KEY ("paid_from_account_id","organization_id") REFERENCES "public"."paid_from_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_card_organization_fk" FOREIGN KEY ("card_id","organization_id") REFERENCES "public"."cards"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_category_organization_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_purchases" ADD CONSTRAINT "card_purchases_expense_organization_fk" FOREIGN KEY ("expense_id","organization_id") REFERENCES "public"."expenses"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardholders" ADD CONSTRAINT "cardholders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardholders" ADD CONSTRAINT "cardholders_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_cardholder_organization_fk" FOREIGN KEY ("cardholder_id","organization_id") REFERENCES "public"."cardholders"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_default_category_organization_fk" FOREIGN KEY ("default_category_id","organization_id") REFERENCES "public"."categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_loads_organization_created_idx" ON "card_loads" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_programs_organization_unique" ON "card_programs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "card_purchases_transaction_token_unique" ON "card_purchases" USING btree ("lithic_transaction_token");--> statement-breakpoint
CREATE UNIQUE INDEX "card_purchases_expense_unique" ON "card_purchases" USING btree ("expense_id") WHERE "card_purchases"."expense_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "card_purchases_organization_authorized_idx" ON "card_purchases" USING btree ("organization_id","authorized_at");--> statement-breakpoint
CREATE INDEX "card_purchases_card_authorized_idx" ON "card_purchases" USING btree ("card_id","authorized_at");--> statement-breakpoint
CREATE INDEX "card_purchases_membership_authorized_idx" ON "card_purchases" USING btree ("membership_id","authorized_at");--> statement-breakpoint
CREATE INDEX "card_purchases_unfinished_idx" ON "card_purchases" USING btree ("updated_at") WHERE "card_purchases"."status" = 'pending' OR "card_purchases"."hold_usd_cents" > 0 OR ("card_purchases"."kind" = 'purchase' AND "card_purchases"."status" = 'settled' AND "card_purchases"."expense_id" IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "cardholders_membership_unique" ON "cardholders" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_lithic_card_token_unique" ON "cards" USING btree ("lithic_card_token");--> statement-breakpoint
CREATE INDEX "cards_organization_created_idx" ON "cards" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "cards_membership_idx" ON "cards" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "cards_close_requested_idx" ON "cards" USING btree ("close_requested_at") WHERE "cards"."close_requested_at" IS NOT NULL AND "cards"."state" <> 'closed';--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_card_purchase_organization_fk" FOREIGN KEY ("card_purchase_id","organization_id") REFERENCES "public"."card_purchases"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_files_card_purchase_id_idx" ON "receipt_files" USING btree ("card_purchase_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_card_recorded" CHECK ("expenses"."kind"::text <> 'card' OR ("expenses"."status" = 'recorded' AND "expenses"."paid_from_account_id" IS NOT NULL AND "expenses"."bill_id" IS NULL));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_links" CHECK ("expenses"."kind"::text IN ('company', 'card') OR ("expenses"."paid_from_account_id" IS NULL AND "expenses"."bill_id" IS NULL));--> statement-breakpoint
ALTER TABLE "receipt_files" ADD CONSTRAINT "receipt_files_card_purchase_not_bill" CHECK ("receipt_files"."card_purchase_id" IS NULL OR "receipt_files"."bill_id" IS NULL);