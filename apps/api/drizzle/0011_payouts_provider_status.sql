ALTER TABLE "payouts" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "provider_checked_at" timestamp with time zone;