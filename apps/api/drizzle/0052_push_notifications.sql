CREATE TYPE "public"."notification_audience" AS ENUM('member', 'admins');--> statement-breakpoint
CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"audience" "notification_audience" NOT NULL,
	"recipient_membership_id" uuid,
	"except_membership_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"device_count" integer,
	"tickets" jsonb,
	"receipts_checked_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_audience_check" CHECK (("notification_outbox"."audience" = 'member' AND "notification_outbox"."recipient_membership_id" IS NOT NULL AND "notification_outbox"."except_membership_id" IS NULL) OR ("notification_outbox"."audience" = 'admins' AND "notification_outbox"."recipient_membership_id" IS NULL)),
	CONSTRAINT "notification_outbox_attempts_check" CHECK ("notification_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "push_platform" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_organization_fk" FOREIGN KEY ("recipient_membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_except_organization_fk" FOREIGN KEY ("except_membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("last_attempt_at","created_at") WHERE "notification_outbox"."sent_at" IS NULL AND "notification_outbox"."abandoned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notification_outbox_unchecked_idx" ON "notification_outbox" USING btree ("sent_at") WHERE "notification_outbox"."receipts_checked_at" IS NULL AND "notification_outbox"."tickets" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_token_unique" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_idx" ON "push_tokens" USING btree ("user_id");