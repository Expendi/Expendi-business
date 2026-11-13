CREATE TYPE "public"."cash_out_provider" AS ENUM('paycrest', 'pretium');--> statement-breakpoint
ALTER TYPE "public"."payout_provider" ADD VALUE 'pretium';--> statement-breakpoint
ALTER TYPE "public"."staff_confirmation_purpose" ADD VALUE 'change_cash_out_provider';--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_base_hop_is_for_a_cash_out";--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_whole_shillings";--> statement-breakpoint
DROP INDEX "payouts_provider_order_id_unique";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "refund_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "refund_tx_hash" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "active_cash_out_provider" "cash_out_provider" DEFAULT 'paycrest' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_refund_tx_hash_unique" ON "payouts" USING btree ("refund_tx_hash") WHERE "payouts"."refund_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_order_id_unique" ON "payouts" USING btree ("provider","provider_order_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_refund_tx_hash_is_bytes32" CHECK ("payouts"."refund_tx_hash" ~ '^0x[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_refund_is_pretium" CHECK ("payouts"."provider"::text = 'pretium' OR ("payouts"."refund_requested_at" IS NULL AND "payouts"."refund_tx_hash" IS NULL));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_base_hop_is_for_a_cash_out" CHECK ("payouts"."base_hop_quote_id" IS NULL OR "payouts"."provider" <> 'onchain');--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_whole_shillings" CHECK ("payouts"."provider" = 'onchain' OR "payouts"."amount_kes" % 100 = 0);