CREATE TYPE "public"."invoice_payment_kind" AS ENUM('link', 'outside', 'matched');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'open', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."invoice_terms" AS ENUM('on_receipt', 'net_15', 'net_30', 'custom');--> statement-breakpoint
ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'invoice_payment';--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_id_organization_id_unique" UNIQUE("id","organization_id");--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"address" text,
	"tax_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_id_organization_id_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" "invoice_payment_kind" NOT NULL,
	"intent_quote_id" uuid,
	"wallet_transaction_id" uuid,
	"amount_usdc" bigint,
	"paid_on" date NOT NULL,
	"reference" text,
	"note" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payments_intent_quote_id_unique" UNIQUE("intent_quote_id"),
	CONSTRAINT "invoice_payments_wallet_transaction_id_unique" UNIQUE("wallet_transaction_id"),
	CONSTRAINT "invoice_payments_kind_has_sources" CHECK (("invoice_payments"."kind" = 'link' AND "invoice_payments"."intent_quote_id" IS NOT NULL AND "invoice_payments"."wallet_transaction_id" IS NOT NULL AND "invoice_payments"."amount_usdc" IS NOT NULL) OR ("invoice_payments"."kind" = 'matched' AND "invoice_payments"."intent_quote_id" IS NULL AND "invoice_payments"."wallet_transaction_id" IS NOT NULL AND "invoice_payments"."amount_usdc" IS NOT NULL) OR ("invoice_payments"."kind" = 'outside' AND "invoice_payments"."intent_quote_id" IS NULL AND "invoice_payments"."wallet_transaction_id" IS NULL AND "invoice_payments"."amount_usdc" IS NULL)),
	CONSTRAINT "invoice_payments_amount_positive" CHECK ("invoice_payments"."amount_usdc" IS NULL OR "invoice_payments"."amount_usdc" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(15, 3) NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "invoice_line_items_invoice_position_unique" UNIQUE("invoice_id","position"),
	CONSTRAINT "invoice_line_items_values" CHECK ("invoice_line_items"."position" >= 0 AND "invoice_line_items"."quantity" > 0 AND "invoice_line_items"."unit_price_cents" >= 0 AND "invoice_line_items"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"terms" "invoice_terms" DEFAULT 'net_30' NOT NULL,
	"issue_on" date NOT NULL,
	"due_on" date NOT NULL,
	"tax_rate_bps" integer,
	"tax_label" text DEFAULT 'VAT' NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"note" text,
	"bill_to" jsonb,
	"from_party" jsonb,
	"public_id" text,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"voided_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "invoices_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "invoices_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "invoices_amounts" CHECK ("invoices"."subtotal_cents" >= 0 AND "invoices"."tax_cents" >= 0 AND "invoices"."total_cents" = "invoices"."subtotal_cents" + "invoices"."tax_cents"),
	CONSTRAINT "invoices_tax_rate_bps" CHECK ("invoices"."tax_rate_bps" IS NULL OR "invoices"."tax_rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "invoices_due_not_before_issue" CHECK ("invoices"."due_on" >= "invoices"."issue_on"),
	CONSTRAINT "invoices_sent_has_snapshot" CHECK (("invoices"."status" = 'draft') = ("invoices"."sent_at" IS NULL) AND ("invoices"."status" = 'draft') = ("invoices"."bill_to" IS NULL) AND ("invoices"."status" = 'draft') = ("invoices"."from_party" IS NULL) AND ("invoices"."status" = 'draft') = ("invoices"."public_id" IS NULL)),
	CONSTRAINT "invoices_paid_has_time" CHECK (("invoices"."status" = 'paid') = ("invoices"."paid_at" IS NOT NULL)),
	CONSTRAINT "invoices_void_recorded" CHECK (("invoices"."status" = 'void') = ("invoices"."voided_at" IS NOT NULL) AND ("invoices"."status" = 'void') = ("invoices"."voided_reason" IS NOT NULL) AND ("invoices"."status" = 'void') = ("invoices"."voided_by" IS NOT NULL) AND ("invoices"."voided_reason" IS NULL OR length(btrim("invoices"."voided_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "intent_quotes" DROP CONSTRAINT "intent_quotes_intents_side_matches_purpose";--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_organization_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."invoices"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_intent_quote_organization_fk" FOREIGN KEY ("intent_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_wallet_transaction_organization_fk" FOREIGN KEY ("wallet_transaction_id","organization_id") REFERENCES "public"."wallet_transactions"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_organization_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."invoices"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_organization_fk" FOREIGN KEY ("customer_id","organization_id") REFERENCES "public"."customers"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_organization_name_idx" ON "customers" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_id_idx" ON "invoice_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_organization_status_due_on_idx" ON "invoices" USING btree ("organization_id","status","due_on");--> statement-breakpoint
CREATE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_invoice_organization_fk" FOREIGN KEY ("invoice_id","organization_id") REFERENCES "public"."invoices"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_quotes_invoice_id_idx" ON "intent_quotes" USING btree ("invoice_id") WHERE "intent_quotes"."invoice_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_invoice_matches_purpose" CHECK (("intent_quotes"."invoice_id" IS NOT NULL) = ("intent_quotes"."purpose"::text = 'invoice_payment'));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_intents_side_matches_purpose" CHECK (("intent_quotes"."deposit_type" = 'INTENTS') = ("intent_quotes"."purpose"::text = 'fund_in_return') AND ("intent_quotes"."refund_type" = 'ORIGIN_CHAIN' OR "intent_quotes"."purpose"::text IN ('fund_in', 'fund_in_return', 'invoice_payment')));