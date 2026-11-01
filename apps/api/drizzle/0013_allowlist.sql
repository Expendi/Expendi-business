ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'change_allowlist';--> statement-breakpoint
CREATE TABLE "withdrawal_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"added_by" uuid NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_approval_is_bound";--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_funding_has_order";--> statement-breakpoint
ALTER TABLE "withdrawal_addresses" ADD CONSTRAINT "withdrawal_addresses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_addresses" ADD CONSTRAINT "withdrawal_addresses_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_addresses" ADD CONSTRAINT "withdrawal_addresses_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_addresses_active_unique" ON "withdrawal_addresses" USING btree ("organization_id","address") WHERE "withdrawal_addresses"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "withdrawal_addresses_organization_id_idx" ON "withdrawal_addresses" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_confirmation_is_bound" CHECK ("webauthn_challenges"."purpose" = 'register_passkey' OR ("webauthn_challenges"."organization_id" IS NOT NULL AND "webauthn_challenges"."intent_hash" IS NOT NULL AND ("webauthn_challenges"."purpose" <> 'approve_payouts' OR "webauthn_challenges"."payout_ids" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_funding_is_complete" CHECK ("payouts"."status" NOT IN ('funding', 'paying', 'paid') OR ("payouts"."amount_to_transfer_usdc" IS NOT NULL AND "payouts"."deposit_address" IS NOT NULL AND "payouts"."funding_started_at" IS NOT NULL AND ("payouts"."provider" <> 'paycrest' OR "payouts"."provider_order_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_onchain_is_usdc" CHECK (("payouts"."provider" = 'onchain') = ("payouts"."method" = 'usdc'));