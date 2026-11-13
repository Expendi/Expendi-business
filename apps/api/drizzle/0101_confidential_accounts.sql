CREATE TYPE "public"."one_click_recipient_type" AS ENUM('DESTINATION_CHAIN', 'CONFIDENTIAL_INTENTS');--> statement-breakpoint
CREATE TYPE "public"."wallet_balance_home" AS ENUM('company_wallet', 'confidential_account');--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'move_in';--> statement-breakpoint
ALTER TYPE "public"."one_click_account_type" ADD VALUE 'CONFIDENTIAL_INTENTS';--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "recipient_type" "one_click_recipient_type" DEFAULT 'DESTINATION_CHAIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "signed_intent" jsonb;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "intent_hash" text;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "intent_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "intent_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "balance_home" "wallet_balance_home" DEFAULT 'company_wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_signed_intent_has_deadline" CHECK (("intent_quotes"."signed_intent" IS NOT NULL) = ("intent_quotes"."intent_deadline" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_intent_submitted_is_signed" CHECK ("intent_quotes"."signed_intent" IS NOT NULL OR ("intent_quotes"."intent_hash" IS NULL AND "intent_quotes"."intent_submitted_at" IS NULL));