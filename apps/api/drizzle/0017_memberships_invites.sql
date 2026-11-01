ALTER TABLE "memberships" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_organization_email_unique" ON "memberships" USING btree ("organization_id","email") WHERE "memberships"."email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_email_lowercase" CHECK ("memberships"."email" = lower("memberships"."email"));