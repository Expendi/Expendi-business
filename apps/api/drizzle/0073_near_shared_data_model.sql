CREATE TYPE "public"."intent_quote_purpose" AS ENUM('base_hop', 'sweep', 'fund_in', 'usdc_payout');--> statement-breakpoint
CREATE TYPE "public"."intent_quote_status" AS ENUM('quoted', 'depositing', 'succeeded', 'refunded', 'failed', 'expired', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."intent_quote_swap_type" AS ENUM('EXACT_INPUT', 'EXACT_OUTPUT');--> statement-breakpoint
CREATE TYPE "public"."one_click_status" AS ENUM('PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payee_chain" AS ENUM('near', 'base', 'solana');--> statement-breakpoint
CREATE TABLE "intent_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"quote_key" text NOT NULL,
	"purpose" "intent_quote_purpose" NOT NULL,
	"status" "intent_quote_status" DEFAULT 'quoted' NOT NULL,
	"swap_type" "intent_quote_swap_type" NOT NULL,
	"origin_asset" text NOT NULL,
	"destination_asset" text NOT NULL,
	"amount_in" numeric(39, 0) NOT NULL,
	"min_amount_in" numeric(39, 0),
	"amount_out" numeric(39, 0) NOT NULL,
	"min_amount_out" numeric(39, 0),
	"deposit_address" text NOT NULL,
	"recipient" text NOT NULL,
	"refund_to" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"quote_response" jsonb NOT NULL,
	"company_wallet_send_id" uuid,
	"deposit_started_at" timestamp with time zone,
	"deposit_privy_transaction_id" text,
	"deposit_tx_hash" text,
	"deposit_submitted_at" timestamp with time zone,
	"fee_cover_usdc" bigint,
	"fee_cover_tx_hash" text,
	"deposit_registration_tx_hash" text,
	"one_click_status" "one_click_status",
	"one_click_checked_at" timestamp with time zone,
	"near_tx_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin_chain_tx_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"destination_chain_tx_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"deposited_amount" numeric(39, 0),
	"swapped_amount_in" numeric(39, 0),
	"swapped_amount_out" numeric(39, 0),
	"refunded_amount" numeric(39, 0),
	"refund_reason" text,
	"failure" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intent_quotes_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "intent_quotes_amounts_positive" CHECK ("intent_quotes"."amount_in" > 0 AND "intent_quotes"."amount_out" > 0 AND ("intent_quotes"."min_amount_in" IS NULL OR ("intent_quotes"."min_amount_in" > 0 AND "intent_quotes"."min_amount_in" <= "intent_quotes"."amount_in")) AND ("intent_quotes"."min_amount_out" IS NULL OR ("intent_quotes"."min_amount_out" > 0 AND "intent_quotes"."min_amount_out" <= "intent_quotes"."amount_out"))),
	CONSTRAINT "intent_quotes_settled_has_time" CHECK (("intent_quotes"."status" IN ('succeeded', 'refunded', 'failed', 'expired')) = ("intent_quotes"."settled_at" IS NOT NULL)),
	CONSTRAINT "intent_quotes_send_is_from_company_wallet" CHECK ("intent_quotes"."company_wallet_send_id" IS NULL OR "intent_quotes"."purpose" IN ('base_hop', 'usdc_payout')),
	CONSTRAINT "intent_quotes_fee_cover_is_for_a_hop" CHECK (("intent_quotes"."fee_cover_usdc" IS NULL OR ("intent_quotes"."fee_cover_usdc" > 0 AND "intent_quotes"."purpose" = 'base_hop')) AND ("intent_quotes"."fee_cover_tx_hash" IS NULL OR "intent_quotes"."fee_cover_usdc" IS NOT NULL)),
	CONSTRAINT "intent_quotes_expired_never_deposited" CHECK ("intent_quotes"."status" <> 'expired' OR ("intent_quotes"."deposit_started_at" IS NULL AND "intent_quotes"."company_wallet_send_id" IS NULL AND "intent_quotes"."deposit_tx_hash" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payees" DROP CONSTRAINT "payees_usdc_details";--> statement-breakpoint
DROP INDEX "wallet_transactions_tx_log_unique";--> statement-breakpoint
DROP INDEX "withdrawal_addresses_active_unique";--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN "usdc_chain" "payee_chain";--> statement-breakpoint
-- Hand-written: every USDC payee saved before payee chains is on Base.
-- FORCE row-level security applies to this owner role too, so it is lifted
-- for the backfill alone.
ALTER TABLE "payees" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "payees" SET "usdc_chain" = 'base' WHERE "usdc_address" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payees" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "base_hop_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "delivery_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "chain" "wallet_chain" DEFAULT 'base' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "receipt_id" text;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "transfer_index" integer;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "deposits_resume_token" text;--> statement-breakpoint
-- Hand-written: every address listed before payee chains is on Base. The
-- default exists only to fill those rows; the API always states the chain.
ALTER TABLE "withdrawal_addresses" ADD COLUMN "chain" "payee_chain" DEFAULT 'base' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_addresses" ALTER COLUMN "chain" DROP DEFAULT;--> statement-breakpoint
-- Hand-moved: the foreign key to it below needs this constraint first.
ALTER TABLE "company_wallet_sends" ADD CONSTRAINT "company_wallet_sends_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_wallet_organization_fk" FOREIGN KEY ("wallet_id","organization_id") REFERENCES "public"."wallets"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_company_wallet_send_organization_fk" FOREIGN KEY ("company_wallet_send_id","organization_id") REFERENCES "public"."company_wallet_sends"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intent_quotes_quote_key_unique" ON "intent_quotes" USING btree ("organization_id","quote_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_quotes_deposit_address_unique" ON "intent_quotes" USING btree ("deposit_address");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_quotes_company_wallet_send_unique" ON "intent_quotes" USING btree ("company_wallet_send_id");--> statement-breakpoint
CREATE INDEX "intent_quotes_unsettled_idx" ON "intent_quotes" USING btree ("organization_id") WHERE "intent_quotes"."status" IN ('quoted', 'depositing', 'needs_review');--> statement-breakpoint
CREATE INDEX "intent_quotes_near_tx_hashes_idx" ON "intent_quotes" USING gin ("near_tx_hashes");--> statement-breakpoint
CREATE INDEX "intent_quotes_destination_chain_tx_hashes_idx" ON "intent_quotes" USING gin ("destination_chain_tx_hashes");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_base_hop_quote_organization_fk" FOREIGN KEY ("base_hop_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_delivery_quote_organization_fk" FOREIGN KEY ("delivery_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_base_hop_quote_id_idx" ON "payouts" USING btree ("base_hop_quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_delivery_quote_id_unique" ON "payouts" USING btree ("delivery_quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_base_transfer_unique" ON "wallet_transactions" USING btree (lower("tx_hash"),"log_index") WHERE "wallet_transactions"."chain" = 'base';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_near_transfer_unique" ON "wallet_transactions" USING btree ("receipt_id","log_index","transfer_index") WHERE "wallet_transactions"."chain" <> 'base';--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_addresses_active_unique" ON "withdrawal_addresses" USING btree ("organization_id","chain","address") WHERE "withdrawal_addresses"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_usdc_chain_with_address" CHECK (("payees"."usdc_chain" IS NULL) = ("payees"."usdc_address" IS NULL));--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_usdc_address_matches_chain" CHECK ("payees"."usdc_address" IS NULL OR ("payees"."usdc_chain" = 'base' AND "payees"."usdc_address" ~ '^0x[0-9a-f]{40}$') OR ("payees"."usdc_chain" = 'near' AND length("payees"."usdc_address") BETWEEN 2 AND 64 AND "payees"."usdc_address" ~ '^(([a-z0-9]+[-_])*[a-z0-9]+[.])*([a-z0-9]+[-_])*[a-z0-9]+$') OR ("payees"."usdc_chain" = 'solana' AND "payees"."usdc_address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'));--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_usdc_details" CHECK ("payees"."method" IS DISTINCT FROM 'usdc' OR ("payees"."usdc_address" IS NOT NULL AND num_nonnulls("payees"."phone", "payees"."till_number", "payees"."paybill_number", "payees"."account_reference", "payees"."bank_code", "payees"."bank_account_number", "payees"."account_name") = 0));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_base_hop_is_for_a_cash_out" CHECK ("payouts"."base_hop_quote_id" IS NULL OR "payouts"."provider" = 'paycrest');--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_delivery_quote_is_for_usdc" CHECK ("payouts"."delivery_quote_id" IS NULL OR "payouts"."provider" = 'onchain');--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_receipt_is_near" CHECK (("wallet_transactions"."receipt_id" IS NULL AND "wallet_transactions"."transfer_index" IS NULL) OR ("wallet_transactions"."chain" <> 'base' AND "wallet_transactions"."receipt_id" IS NOT NULL AND "wallet_transactions"."transfer_index" IS NOT NULL AND "wallet_transactions"."log_index" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_near_deposit_has_receipt" CHECK ("wallet_transactions"."chain" = 'base' OR "wallet_transactions"."type" <> 'deposit' OR "wallet_transactions"."receipt_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_positions_not_negative" CHECK (("wallet_transactions"."log_index" IS NULL OR "wallet_transactions"."log_index" >= 0) AND ("wallet_transactions"."transfer_index" IS NULL OR "wallet_transactions"."transfer_index" >= 0));--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_near_hashes_are_base58" CHECK ("wallet_transactions"."chain" = 'base' OR (("wallet_transactions"."tx_hash" IS NULL OR "wallet_transactions"."tx_hash" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') AND ("wallet_transactions"."receipt_id" IS NULL OR "wallet_transactions"."receipt_id" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')));--> statement-breakpoint
ALTER TABLE "withdrawal_addresses" ADD CONSTRAINT "withdrawal_addresses_address_matches_chain" CHECK (("withdrawal_addresses"."chain" = 'base' AND "withdrawal_addresses"."address" ~ '^0x[0-9a-f]{40}$') OR ("withdrawal_addresses"."chain" = 'near' AND length("withdrawal_addresses"."address") BETWEEN 2 AND 64 AND "withdrawal_addresses"."address" ~ '^(([a-z0-9]+[-_])*[a-z0-9]+[.])*([a-z0-9]+[-_])*[a-z0-9]+$') OR ("withdrawal_addresses"."chain" = 'solana' AND "withdrawal_addresses"."address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'));