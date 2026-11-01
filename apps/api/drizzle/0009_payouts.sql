CREATE TYPE "public"."webauthn_purpose" AS ENUM('register_passkey', 'approve_payouts');--> statement-breakpoint
CREATE TYPE "public"."payout_method" AS ENUM('mpesa_phone', 'mpesa_till', 'mpesa_paybill', 'bank', 'usdc');--> statement-breakpoint
CREATE TYPE "public"."payout_provider" AS ENUM('paycrest', 'onchain');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('awaiting_approval', 'approved', 'order_created', 'funding', 'paying', 'paid', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."payout_subject_type" AS ENUM('claim', 'bill', 'float');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'paying', 'paid', 'partly_failed');--> statement-breakpoint
CREATE TABLE "approval_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"purpose" "webauthn_purpose" NOT NULL,
	"challenge" text NOT NULL,
	"intent_hash" text,
	"payout_ids" uuid[],
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_challenges_approval_is_bound" CHECK ("webauthn_challenges"."purpose" <> 'approve_payouts' OR ("webauthn_challenges"."organization_id" IS NOT NULL AND "webauthn_challenges"."intent_hash" IS NOT NULL AND "webauthn_challenges"."payout_ids" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"subject_type" "payout_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"payroll_run_id" uuid,
	"idempotency_key" text NOT NULL,
	"provider" "payout_provider" DEFAULT 'paycrest' NOT NULL,
	"method" "payout_method" NOT NULL,
	"recipient" jsonb NOT NULL,
	"requested_kes_cents" bigint NOT NULL,
	"amount_kes" bigint NOT NULL,
	"quoted_rate" text NOT NULL,
	"quoted_usdc" bigint NOT NULL,
	"max_debit_usdc" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'awaiting_approval' NOT NULL,
	"approval_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"order_requested_at" timestamp with time zone,
	"provider_order_id" text,
	"rate" text,
	"usdc_amount" bigint,
	"fee_usdc" bigint,
	"amount_to_transfer_usdc" bigint,
	"deposit_address" text,
	"deposit_valid_until" timestamp with time zone,
	"funding_started_at" timestamp with time zone,
	"privy_transaction_id" text,
	"tx_hash" text,
	"provider_reference" text,
	"failure_reason" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_whole_shillings" CHECK ("payouts"."provider" <> 'paycrest' OR "payouts"."amount_kes" % 100 = 0),
	CONSTRAINT "payouts_amounts_positive" CHECK ("payouts"."requested_kes_cents" > 0 AND "payouts"."amount_kes" >= "payouts"."requested_kes_cents" AND "payouts"."quoted_usdc" > 0 AND "payouts"."max_debit_usdc" >= "payouts"."quoted_usdc"),
	CONSTRAINT "payouts_funding_has_order" CHECK ("payouts"."status" NOT IN ('funding', 'paying', 'paid') OR ("payouts"."provider_order_id" IS NOT NULL AND "payouts"."amount_to_transfer_usdc" IS NOT NULL AND "payouts"."deposit_address" IS NOT NULL AND "payouts"."funding_started_at" IS NOT NULL)),
	CONSTRAINT "payouts_approved_has_approver" CHECK ("payouts"."status" = 'awaiting_approval' OR "payouts"."status" = 'failed' OR ("payouts"."approved_by" IS NOT NULL AND "payouts"."approved_at" IS NOT NULL AND "payouts"."approval_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pay_date" date NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"total_kes" bigint NOT NULL,
	"cap_kes" bigint NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "payroll_runs_amounts" CHECK ("payroll_runs"."total_kes" >= 0 AND "payroll_runs"."cap_kes" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"payouts_paused" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_single_row" CHECK ("platform_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_passkeys" ADD CONSTRAINT "approval_passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_wallet_organization_fk" FOREIGN KEY ("wallet_id","organization_id") REFERENCES "public"."wallets"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payroll_run_organization_fk" FOREIGN KEY ("payroll_run_id","organization_id") REFERENCES "public"."payroll_runs"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_passkeys_credential_id_unique" ON "approval_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "approval_passkeys_user_id_idx" ON "approval_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_id_idx" ON "webauthn_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_idempotency_key_unique" ON "payouts" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_one_live_per_subject" ON "payouts" USING btree ("organization_id","subject_type","subject_id") WHERE "payouts"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_order_id_unique" ON "payouts" USING btree ("provider_order_id");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status");--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_payout_debit_unique" ON "wallet_transactions" USING btree ("payout_id") WHERE "wallet_transactions"."type" = 'payout';--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payout_has_payout" CHECK ("wallet_transactions"."type" <> 'payout' OR "wallet_transactions"."payout_id" IS NOT NULL);