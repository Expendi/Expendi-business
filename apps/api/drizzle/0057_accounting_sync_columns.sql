ALTER TABLE "accounting_connections" ADD COLUMN "petty_cash_account_id" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "salaries_account_id" text;--> statement-breakpoint
ALTER TABLE "accounting_syncs" ADD COLUMN "external_organization_id" text;--> statement-breakpoint
ALTER TABLE "accounting_syncs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;