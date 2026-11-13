CREATE TYPE "public"."treasury_earn_kind" AS ENUM('deposit', 'withdraw');--> statement-breakpoint
CREATE TYPE "public"."treasury_earn_status" AS ENUM('saved', 'pending', 'succeeded', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."treasury_move_direction" AS ENUM('to_treasury', 'to_wallet');--> statement-breakpoint
CREATE TYPE "public"."treasury_move_status" AS ENUM('open', 'completed', 'returned', 'failed', 'needs_review');--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'turn_on_treasury';--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'move_to_treasury';--> statement-breakpoint
ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'move_to_wallet';--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'to_treasury';--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'from_treasury';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'to_treasury';--> statement-breakpoint
ALTER TYPE "public"."wallet_transaction_type" ADD VALUE 'from_treasury';--> statement-breakpoint
CREATE TABLE "treasury_earn_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"treasury_move_id" uuid NOT NULL,
	"intent_quote_id" uuid,
	"kind" "treasury_earn_kind" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"reference_id" text NOT NULL,
	"raw_amount" bigint NOT NULL,
	"share_amount" bigint,
	"privy_action_id" text,
	"status" "treasury_earn_status" DEFAULT 'saved' NOT NULL,
	"tx_hash" text,
	"delivered_usdc" bigint,
	"call_started_at" timestamp with time zone,
	"failure" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_earn_actions_attempt_unique" UNIQUE("treasury_move_id","intent_quote_id","kind","attempt"),
	CONSTRAINT "treasury_earn_actions_delivered_is_a_withdrawal" CHECK ("treasury_earn_actions"."delivered_usdc" IS NULL OR ("treasury_earn_actions"."kind"::text = 'withdraw' AND "treasury_earn_actions"."status"::text = 'succeeded' AND "treasury_earn_actions"."delivered_usdc" > 0)),
	CONSTRAINT "treasury_earn_actions_raw_amount_positive" CHECK ("treasury_earn_actions"."raw_amount" > 0),
	CONSTRAINT "treasury_earn_actions_attempt_positive" CHECK ("treasury_earn_actions"."attempt" > 0),
	CONSTRAINT "treasury_earn_actions_reference_id_length" CHECK (char_length("treasury_earn_actions"."reference_id") <= 64),
	CONSTRAINT "treasury_earn_actions_deposit_has_quote" CHECK (("treasury_earn_actions"."kind"::text = 'deposit') <= ("treasury_earn_actions"."intent_quote_id" IS NOT NULL)),
	CONSTRAINT "treasury_earn_actions_acted_has_action_id" CHECK ("treasury_earn_actions"."status"::text NOT IN ('pending', 'succeeded', 'failed') OR "treasury_earn_actions"."privy_action_id" IS NOT NULL),
	CONSTRAINT "treasury_earn_actions_settled_has_time" CHECK (("treasury_earn_actions"."status"::text IN ('succeeded', 'rejected', 'failed')) = ("treasury_earn_actions"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
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
ALTER TABLE "wallets" ADD COLUMN "treasury_privy_wallet_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_address" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_privy_policy_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_turned_on_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_turned_on_by" uuid;--> statement-breakpoint
ALTER TABLE "treasury_earn_actions" ADD CONSTRAINT "treasury_earn_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_earn_actions" ADD CONSTRAINT "treasury_earn_actions_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_earn_actions" ADD CONSTRAINT "treasury_earn_actions_quote_organization_fk" FOREIGN KEY ("intent_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_wallet_organization_fk" FOREIGN KEY ("wallet_id","organization_id") REFERENCES "public"."wallets"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_reference_id_unique" ON "treasury_earn_actions" USING btree ("reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_privy_action_id_unique" ON "treasury_earn_actions" USING btree ("privy_action_id") WHERE "treasury_earn_actions"."privy_action_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_one_live_per_move" ON "treasury_earn_actions" USING btree ("treasury_move_id") WHERE "treasury_earn_actions"."status" IN ('saved', 'pending');--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_one_deposit_per_quote" ON "treasury_earn_actions" USING btree ("intent_quote_id") WHERE "treasury_earn_actions"."kind" = 'deposit' AND "treasury_earn_actions"."status" IN ('saved', 'pending', 'succeeded');--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_one_withdrawal_per_move" ON "treasury_earn_actions" USING btree ("treasury_move_id") WHERE "treasury_earn_actions"."kind" = 'withdraw';--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_moves_one_unsettled_per_company" ON "treasury_moves" USING btree ("organization_id") WHERE "treasury_moves"."status" IN ('open', 'needs_review');--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_treasury_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_treasury_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_intent_quote_organization_fk" FOREIGN KEY ("intent_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_treasury_turned_on_by_users_id_fk" FOREIGN KEY ("treasury_turned_on_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_quotes_treasury_move_id_idx" ON "intent_quotes" USING btree ("treasury_move_id") WHERE "intent_quotes"."treasury_move_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_to_treasury_quote_unique" ON "wallet_transactions" USING btree ("intent_quote_id") WHERE "wallet_transactions"."intent_quote_id" IS NOT NULL AND "wallet_transactions"."usdc_amount" < 0;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_treasury_privy_wallet_id_unique" ON "wallets" USING btree ("treasury_privy_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_treasury_address_unique" ON "wallets" USING btree (lower("treasury_address"));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_treasury_move_matches_purpose" CHECK (("intent_quotes"."treasury_move_id" IS NOT NULL) = ("intent_quotes"."purpose"::text IN ('to_treasury', 'from_treasury')));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_send_is_from_company_wallet" CHECK ("intent_quotes"."company_wallet_send_id" IS NULL OR "intent_quotes"."purpose"::text IN ('base_hop', 'usdc_payout', 'fund_in_return', 'to_treasury'));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_treasury_has_move" CHECK (("wallet_transactions"."type"::text IN ('to_treasury', 'from_treasury')) = ("wallet_transactions"."treasury_move_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_quote_link_is_treasury" CHECK (("wallet_transactions"."type"::text = 'to_treasury') <= ("wallet_transactions"."intent_quote_id" IS NOT NULL) AND ("wallet_transactions"."intent_quote_id" IS NULL OR "wallet_transactions"."type"::text IN ('to_treasury', 'from_treasury')));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_amount_sign" CHECK (("wallet_transactions"."type"::text IN ('deposit', 'refund', 'topup', 'from_treasury') AND "wallet_transactions"."usdc_amount" > 0) OR ("wallet_transactions"."type"::text IN ('payout', 'withdrawal', 'to_treasury') AND "wallet_transactions"."usdc_amount" < 0));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_treasury_on_is_complete" CHECK ("wallets"."treasury_turned_on_at" IS NULL OR ("wallets"."treasury_privy_wallet_id" IS NOT NULL AND "wallets"."treasury_address" IS NOT NULL AND "wallets"."treasury_privy_policy_id" IS NOT NULL));