ALTER TABLE "memberships" DROP CONSTRAINT "memberships_email_lowercase";--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_identity_check";--> statement-breakpoint
DROP INDEX "memberships_organization_email_unique";--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "full_name";