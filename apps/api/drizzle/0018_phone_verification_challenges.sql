CREATE TYPE "public"."phone_verification_status" AS ENUM('pending', 'approved', 'verified', 'expired');--> statement-breakpoint
CREATE TABLE "phone_verification_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"provider_ref" text,
	"status" "phone_verification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verification_challenges_counts" CHECK ("phone_verification_challenges"."attempts" >= 0 AND "phone_verification_challenges"."send_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "phone_verification_challenges" ADD CONSTRAINT "phone_verification_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_verification_challenges_user_id_idx" ON "phone_verification_challenges" USING btree ("user_id","last_sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_verification_challenges_one_pending" ON "phone_verification_challenges" USING btree ("user_id") WHERE "phone_verification_challenges"."status" = 'pending';