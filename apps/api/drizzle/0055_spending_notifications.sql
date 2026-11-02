ALTER TABLE "notification_outbox" ADD COLUMN "channel" text DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "email_recipients_sent" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_event_channel_unique" ON "notification_outbox" USING btree ("organization_id","dedupe_key","channel");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_channel_check" CHECK ("notification_outbox"."channel" IN ('push', 'email'));