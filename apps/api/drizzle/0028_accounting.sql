CREATE TYPE "public"."accounting_connection_status" AS ENUM('pending', 'active', 'needs_reconnect', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."accounting_provider" AS ENUM('zoho_books');--> statement-breakpoint
CREATE TYPE "public"."accounting_sync_status" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."accounting_sync_subject_type" AS ENUM('expense', 'bill', 'payroll_run');--> statement-breakpoint
CREATE TABLE "accounting_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "accounting_provider" DEFAULT 'zoho_books' NOT NULL,
	"external_organization_id" text,
	"external_organization_name" text,
	"accounts_server" text,
	"api_domain" text,
	"refresh_token_encrypted" text,
	"paid_through_account_id" text,
	"default_account_id" text,
	"status" "accounting_connection_status" DEFAULT 'pending' NOT NULL,
	"connect_token_hash" text,
	"connect_token_expires_at" timestamp with time zone,
	"connect_token_used_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_connections_connect_token_complete" CHECK (("accounting_connections"."connect_token_hash" IS NULL) = ("accounting_connections"."connect_token_expires_at" IS NULL)),
	CONSTRAINT "accounting_connections_signed_in_complete" CHECK ("accounting_connections"."refresh_token_encrypted" IS NULL OR ("accounting_connections"."accounts_server" IS NOT NULL AND "accounting_connections"."api_domain" IS NOT NULL AND "accounting_connections"."connected_at" IS NOT NULL)),
	CONSTRAINT "accounting_connections_active_ready" CHECK ("accounting_connections"."status" <> 'active' OR ("accounting_connections"."refresh_token_encrypted" IS NOT NULL AND "accounting_connections"."external_organization_id" IS NOT NULL)),
	CONSTRAINT "accounting_connections_disconnected_holds_nothing" CHECK ("accounting_connections"."status" <> 'disconnected' OR ("accounting_connections"."refresh_token_encrypted" IS NULL AND "accounting_connections"."connect_token_hash" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "accounting_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subject_type" "accounting_sync_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"provider" "accounting_provider" DEFAULT 'zoho_books' NOT NULL,
	"external_id" text,
	"status" "accounting_sync_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"receipt_attached" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_syncs_subject_unique" UNIQUE("organization_id","subject_type","subject_id"),
	CONSTRAINT "accounting_syncs_attempts_non_negative" CHECK ("accounting_syncs"."attempts" >= 0),
	CONSTRAINT "accounting_syncs_synced_complete" CHECK ("accounting_syncs"."status" <> 'synced' OR ("accounting_syncs"."external_id" IS NOT NULL AND "accounting_syncs"."synced_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_syncs" ADD CONSTRAINT "accounting_syncs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_connections_one_open_per_organization" ON "accounting_connections" USING btree ("organization_id") WHERE "accounting_connections"."status" <> 'disconnected';--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_connections_connect_token_hash_unique" ON "accounting_connections" USING btree ("connect_token_hash");