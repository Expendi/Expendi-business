ALTER TABLE "wallets" ADD COLUMN "treasury_privy_wallet_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_address" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_privy_policy_id" text;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_turned_on_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "treasury_turned_on_by" uuid;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_treasury_turned_on_by_users_id_fk" FOREIGN KEY ("treasury_turned_on_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_treasury_privy_wallet_id_unique" ON "wallets" USING btree ("treasury_privy_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_treasury_address_unique" ON "wallets" USING btree (lower("treasury_address"));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_treasury_on_is_complete" CHECK ("wallets"."treasury_turned_on_at" IS NULL OR ("wallets"."treasury_privy_wallet_id" IS NOT NULL AND "wallets"."treasury_address" IS NOT NULL AND "wallets"."treasury_privy_policy_id" IS NOT NULL));