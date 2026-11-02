CREATE TYPE "public"."staff_confirmation_purpose" AS ENUM('resolve_payout', 'pause_payouts', 'unpause_payouts');--> statement-breakpoint
CREATE TABLE "staff_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"purpose" "staff_confirmation_purpose" NOT NULL,
	"target" text NOT NULL,
	"params" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"intent_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_confirmations_spent_before_expiry" CHECK ("staff_confirmations"."used_at" IS NULL OR "staff_confirmations"."used_at" <= "staff_confirmations"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "staff_confirmations" ADD CONSTRAINT "staff_confirmations_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_confirmations_token_hash_unique" ON "staff_confirmations" USING btree ("token_hash");