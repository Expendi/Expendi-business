CREATE TYPE "public"."one_click_account_type" AS ENUM('ORIGIN_CHAIN', 'INTENTS');--> statement-breakpoint
ALTER TYPE "public"."company_wallet_send_kind" ADD VALUE 'intents_transfer';--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'fund_in_return';--> statement-breakpoint
ALTER TABLE "intent_quotes" DROP CONSTRAINT "intent_quotes_send_is_from_company_wallet";--> statement-breakpoint
ALTER TABLE "company_wallet_sends" ADD COLUMN "token_id" text;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "deposit_type" "one_click_account_type" DEFAULT 'ORIGIN_CHAIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "refund_type" "one_click_account_type" DEFAULT 'ORIGIN_CHAIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "return_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_return_quote_organization_fk" FOREIGN KEY ("return_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_wallet_sends" ADD CONSTRAINT "company_wallet_sends_token_matches_kind" CHECK (("company_wallet_sends"."kind"::text = 'intents_transfer') = ("company_wallet_sends"."token_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_intents_side_matches_purpose" CHECK (("intent_quotes"."deposit_type" = 'INTENTS') = ("intent_quotes"."purpose"::text = 'fund_in_return') AND ("intent_quotes"."refund_type" = 'ORIGIN_CHAIN' OR "intent_quotes"."purpose"::text IN ('fund_in', 'fund_in_return')));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_return_is_for_a_fund_in" CHECK ("intent_quotes"."return_quote_id" IS NULL OR "intent_quotes"."purpose"::text = 'fund_in');--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_send_is_from_company_wallet" CHECK ("intent_quotes"."company_wallet_send_id" IS NULL OR "intent_quotes"."purpose"::text IN ('base_hop', 'usdc_payout', 'fund_in_return'));