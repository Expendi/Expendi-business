CREATE TYPE "public"."float_movement_status" AS ENUM('pending', 'paid', 'failed', 'recorded');--> statement-breakpoint
CREATE TYPE "public"."float_movement_type" AS ENUM('issue', 'top_up', 'return', 'write_off');--> statement-breakpoint
CREATE TYPE "public"."float_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "float_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"float_id" uuid NOT NULL,
	"type" "float_movement_type" NOT NULL,
	"status" "float_movement_status" NOT NULL,
	"amount_kes" bigint NOT NULL,
	"payout_id" uuid,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "float_movements_amount_positive" CHECK ("float_movements"."amount_kes" > 0),
	CONSTRAINT "float_movements_paid_through_expendi" CHECK (("float_movements"."type" IN ('issue', 'top_up')) = ("float_movements"."payout_id" IS NOT NULL)),
	CONSTRAINT "float_movements_status_for_type" CHECK (CASE WHEN "float_movements"."type" IN ('issue', 'top_up') THEN "float_movements"."status" IN ('pending', 'paid', 'failed') ELSE "float_movements"."status" = 'recorded' END),
	CONSTRAINT "float_movements_paid_at" CHECK (("float_movements"."status" = 'paid') = ("float_movements"."paid_at" IS NOT NULL)),
	CONSTRAINT "float_movements_write_off_reason" CHECK ("float_movements"."type" <> 'write_off' OR ("float_movements"."note" IS NOT NULL AND length(btrim("float_movements"."note")) > 0))
);
--> statement-breakpoint
CREATE TABLE "floats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"status" "float_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floats_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "floats_closed" CHECK (("floats"."status" = 'closed') = ("floats"."closed_at" IS NOT NULL) AND ("floats"."closed_at" IS NULL) = ("floats"."closed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "overspend_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "float_movements" ADD CONSTRAINT "float_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "float_movements" ADD CONSTRAINT "float_movements_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "float_movements" ADD CONSTRAINT "float_movements_float_organization_fk" FOREIGN KEY ("float_id","organization_id") REFERENCES "public"."floats"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "float_movements" ADD CONSTRAINT "float_movements_payout_organization_fk" FOREIGN KEY ("payout_id","organization_id") REFERENCES "public"."payouts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floats" ADD CONSTRAINT "floats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floats" ADD CONSTRAINT "floats_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floats" ADD CONSTRAINT "floats_membership_organization_fk" FOREIGN KEY ("membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "float_movements_one_pending_per_float" ON "float_movements" USING btree ("float_id") WHERE "float_movements"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "float_movements_payout_id_unique" ON "float_movements" USING btree ("payout_id") WHERE "float_movements"."payout_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "float_movements_float_created_idx" ON "float_movements" USING btree ("float_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "floats_one_open_per_membership" ON "floats" USING btree ("membership_id") WHERE "floats"."status" = 'open';--> statement-breakpoint
CREATE INDEX "floats_organization_opened_idx" ON "floats" USING btree ("organization_id","opened_at");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_float_organization_fk" FOREIGN KEY ("float_id","organization_id") REFERENCES "public"."floats"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_overspend_claim_organization_fk" FOREIGN KEY ("overspend_claim_id","organization_id") REFERENCES "public"."expenses"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_overspend_claim_id_unique" ON "expenses" USING btree ("overspend_claim_id") WHERE "expenses"."overspend_claim_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "expenses_float_id_idx" ON "expenses" USING btree ("float_id") WHERE "expenses"."float_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_float_recorded" CHECK ("expenses"."kind" <> 'float' OR ("expenses"."status" = 'recorded' AND "expenses"."float_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_float_link" CHECK ("expenses"."float_id" IS NULL OR "expenses"."kind" IN ('float', 'claim'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_overspend_claim_link" CHECK ("expenses"."overspend_claim_id" IS NULL OR "expenses"."kind" = 'float');