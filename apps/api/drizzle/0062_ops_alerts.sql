CREATE TYPE "public"."ops_alert_kind" AS ENUM('payout_needs_review', 'payout_failed', 'webhook_signature_failure', 'reconciliation_stopped', 'low_company_balance', 'zoho_sync_failing');--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ops_alert_kind" NOT NULL,
	"subject_key" text NOT NULL,
	"organization_id" uuid,
	"title" text NOT NULL,
	"details" jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"next_notify_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notify_error" text,
	CONSTRAINT "ops_alerts_occurrences_positive" CHECK ("ops_alerts"."occurrences" >= 1),
	CONSTRAINT "ops_alerts_notify_attempts_non_negative" CHECK ("ops_alerts"."notify_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "station_heartbeats" (
	"job" text PRIMARY KEY NOT NULL,
	"last_finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_one_open_per_subject" ON "ops_alerts" USING btree ("kind","subject_key") WHERE "ops_alerts"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_payout_failed_once" ON "ops_alerts" USING btree ("subject_key") WHERE "ops_alerts"."kind" = 'payout_failed';--> statement-breakpoint
CREATE INDEX "ops_alerts_unsent_idx" ON "ops_alerts" USING btree ("next_notify_at") WHERE "ops_alerts"."notified_at" IS NULL AND "ops_alerts"."resolved_at" IS NULL;