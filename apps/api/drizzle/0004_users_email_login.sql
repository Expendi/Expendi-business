-- Login moves from phone to email + passkey (spec §4, 2026-11-01). phone becomes
-- the SMS-verified M-Pesa payout number (§6.18). Adding NOT NULL email assumes
-- no users exist yet, which holds: phone login was never deployed.
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_verified" CHECK (("users"."phone" IS NULL) = ("users"."phone_verified_at" IS NULL));