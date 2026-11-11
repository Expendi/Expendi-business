CREATE TYPE "public"."company_wallet_send_kind" AS ENUM('transfer', 'transfer_call');--> statement-breakpoint
CREATE TYPE "public"."company_wallet_send_status" AS ENUM('reserved', 'signed', 'executed', 'failed', 'expired', 'refused');--> statement-breakpoint
ALTER TYPE "public"."wallet_chain" ADD VALUE 'near';--> statement-breakpoint
CREATE TABLE "company_wallet_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"send_key" text NOT NULL,
	"kind" "company_wallet_send_kind" NOT NULL,
	"status" "company_wallet_send_status" DEFAULT 'reserved' NOT NULL,
	"sender_account_id" text NOT NULL,
	"receiver_account_id" text NOT NULL,
	"usdc_amount" bigint NOT NULL,
	"msg" text,
	"nonce" bigint NOT NULL,
	"max_block_height" bigint NOT NULL,
	"signed_delegate" text,
	"relay_tx_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"tx_hash" text,
	"block_height" bigint,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_wallet_sends_amount_positive" CHECK ("company_wallet_sends"."usdc_amount" > 0),
	CONSTRAINT "company_wallet_sends_msg_matches_kind" CHECK (("company_wallet_sends"."kind" = 'transfer_call') = ("company_wallet_sends"."msg" IS NOT NULL)),
	CONSTRAINT "company_wallet_sends_signed_is_saved" CHECK ("company_wallet_sends"."status" NOT IN ('signed', 'executed', 'failed') OR "company_wallet_sends"."signed_delegate" IS NOT NULL),
	CONSTRAINT "company_wallet_sends_ran_has_transaction" CHECK ("company_wallet_sends"."status" NOT IN ('executed', 'failed') OR ("company_wallet_sends"."tx_hash" IS NOT NULL AND "company_wallet_sends"."block_height" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_active_is_complete";--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "chain" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "transit_privy_wallet_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "transit_address" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "onchain_activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_wallet_sends" ADD CONSTRAINT "company_wallet_sends_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_wallet_sends" ADD CONSTRAINT "company_wallet_sends_wallet_organization_fk" FOREIGN KEY ("wallet_id","organization_id") REFERENCES "public"."wallets"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_wallet_sends_live_key_unique" ON "company_wallet_sends" USING btree ("organization_id","send_key") WHERE "company_wallet_sends"."status" IN ('reserved', 'signed', 'executed', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "company_wallet_sends_one_in_flight_per_wallet" ON "company_wallet_sends" USING btree ("wallet_id") WHERE "company_wallet_sends"."status" IN ('reserved', 'signed');--> statement-breakpoint
CREATE UNIQUE INDEX "company_wallet_sends_wallet_nonce_unique" ON "company_wallet_sends" USING btree ("wallet_id","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_transit_privy_wallet_id_unique" ON "wallets" USING btree ("transit_privy_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_transit_address_unique" ON "wallets" USING btree (lower("transit_address"));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_active_is_complete" CHECK ("wallets"."status" <> 'active' OR ("wallets"."privy_policy_id" IS NOT NULL AND "wallets"."privy_wallet_id" IS NOT NULL AND "wallets"."address" IS NOT NULL AND ("wallets"."chain" = 'base' OR ("wallets"."transit_privy_wallet_id" IS NOT NULL AND "wallets"."transit_address" IS NOT NULL AND "wallets"."onchain_activated_at" IS NOT NULL))));