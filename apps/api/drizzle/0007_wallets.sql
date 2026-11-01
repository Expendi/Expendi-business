CREATE TYPE "public"."wallet_transaction_type" AS ENUM('deposit', 'payout', 'refund', 'withdrawal', 'topup');--> statement-breakpoint
CREATE TYPE "public"."wallet_chain" AS ENUM('base');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('creating', 'active');--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" "wallet_transaction_type" NOT NULL,
	"usdc_amount" bigint NOT NULL,
	"tx_hash" text,
	"log_index" integer,
	"block_number" bigint,
	"counterparty_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_amount_sign" CHECK (("wallet_transactions"."type" IN ('deposit', 'refund', 'topup') AND "wallet_transactions"."usdc_amount" > 0) OR ("wallet_transactions"."type" IN ('payout', 'withdrawal') AND "wallet_transactions"."usdc_amount" < 0)),
	CONSTRAINT "wallet_transactions_deposit_is_onchain" CHECK ("wallet_transactions"."type" <> 'deposit' OR ("wallet_transactions"."tx_hash" IS NOT NULL AND "wallet_transactions"."log_index" IS NOT NULL AND "wallet_transactions"."block_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"chain" "wallet_chain" DEFAULT 'base' NOT NULL,
	"status" "wallet_status" DEFAULT 'creating' NOT NULL,
	"per_transaction_max_usdc" bigint NOT NULL,
	"privy_policy_id" text,
	"privy_wallet_id" text,
	"address" text,
	"deposits_watched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "wallets_active_is_complete" CHECK ("wallets"."status" <> 'active' OR ("wallets"."privy_policy_id" IS NOT NULL AND "wallets"."privy_wallet_id" IS NOT NULL AND "wallets"."address" IS NOT NULL)),
	CONSTRAINT "wallets_per_transaction_max_positive" CHECK ("wallets"."per_transaction_max_usdc" > 0)
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_organization_fk" FOREIGN KEY ("wallet_id","organization_id") REFERENCES "public"."wallets"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_tx_log_unique" ON "wallet_transactions" USING btree (lower("tx_hash"),"log_index");--> statement-breakpoint
CREATE INDEX "wallet_transactions_wallet_id_idx" ON "wallet_transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_organization_id_unique" ON "wallets" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_privy_wallet_id_unique" ON "wallets" USING btree ("privy_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_address_unique" ON "wallets" USING btree (lower("address"));