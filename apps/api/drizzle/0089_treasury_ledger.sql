CREATE TYPE "public"."treasury_move_direction" AS ENUM('to_treasury', 'to_wallet');--> statement-breakpoint
CREATE TYPE "public"."treasury_move_status" AS ENUM('open', 'completed', 'returned', 'failed', 'needs_review');--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'to_treasury';--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'from_treasury';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'to_treasury';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'from_treasury';--> statement-breakpoint
CREATE TABLE "treasury_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"direction" "treasury_move_direction" NOT NULL,
	"requested_usdc" bigint NOT NULL,
	"is_all" boolean DEFAULT false NOT NULL,
	"status" "treasury_move_status" DEFAULT 'open' NOT NULL,
	"moved_usdc" bigint,
	"cost_usdc" bigint,
	"confirmed_by" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"failure" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_moves_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "treasury_moves_requested_positive" CHECK ("treasury_moves"."requested_usdc" > 0),
	CONSTRAINT "treasury_moves_all_is_to_wallet" CHECK (NOT "treasury_moves"."is_all" OR "treasury_moves"."direction"::text = 'to_wallet'),
	CONSTRAINT "treasury_moves_moved_not_negative" CHECK ("treasury_moves"."moved_usdc" IS NULL OR "treasury_moves"."moved_usdc" >= 0),
	CONSTRAINT "treasury_moves_settled_has_time" CHECK (("treasury_moves"."status" IN ('completed', 'returned', 'failed')) = ("treasury_moves"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "intent_quotes" DROP CONSTRAINT "intent_quotes_send_is_from_company_wallet";--> statement-breakpoint
ALTER TABLE "wallet_transactions" DROP CONSTRAINT "wallet_transactions_amount_sign";--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "treasury_move_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "treasury_move_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "intent_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_wallet_organization_fk" FOREIGN KEY ("wallet_id","organization_id") REFERENCES "public"."wallets"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_moves_one_unsettled_per_company" ON "treasury_moves" USING btree ("organization_id") WHERE "treasury_moves"."status" IN ('open', 'needs_review');--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_treasury_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_treasury_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_intent_quote_organization_fk" FOREIGN KEY ("intent_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_quotes_treasury_move_id_idx" ON "intent_quotes" USING btree ("treasury_move_id") WHERE "intent_quotes"."treasury_move_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_to_treasury_quote_unique" ON "wallet_transactions" USING btree ("intent_quote_id") WHERE "wallet_transactions"."intent_quote_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_treasury_move_matches_purpose" CHECK (("intent_quotes"."treasury_move_id" IS NOT NULL) = ("intent_quotes"."purpose"::text IN ('to_treasury', 'from_treasury')));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_send_is_from_company_wallet" CHECK ("intent_quotes"."company_wallet_send_id" IS NULL OR "intent_quotes"."purpose"::text IN ('base_hop', 'usdc_payout', 'fund_in_return', 'to_treasury'));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_treasury_has_move" CHECK (("wallet_transactions"."type"::text IN ('to_treasury', 'from_treasury')) = ("wallet_transactions"."treasury_move_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_to_treasury_has_quote" CHECK (("wallet_transactions"."type"::text = 'to_treasury') = ("wallet_transactions"."intent_quote_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_amount_sign" CHECK (("wallet_transactions"."type"::text IN ('deposit', 'refund', 'topup', 'from_treasury') AND "wallet_transactions"."usdc_amount" > 0) OR ("wallet_transactions"."type"::text IN ('payout', 'withdrawal', 'to_treasury') AND "wallet_transactions"."usdc_amount" < 0));