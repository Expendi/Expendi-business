CREATE TYPE "public"."treasury_earn_kind" AS ENUM('deposit', 'withdraw');--> statement-breakpoint
CREATE TYPE "public"."treasury_earn_status" AS ENUM('saved', 'pending', 'succeeded', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "treasury_earn_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"treasury_move_id" uuid NOT NULL,
	"intent_quote_id" uuid,
	"kind" "treasury_earn_kind" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"reference_id" text NOT NULL,
	"raw_amount" bigint NOT NULL,
	"share_amount" bigint,
	"privy_action_id" text,
	"status" "treasury_earn_status" DEFAULT 'saved' NOT NULL,
	"tx_hash" text,
	"call_started_at" timestamp with time zone,
	"failure" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_earn_actions_attempt_unique" UNIQUE("treasury_move_id","intent_quote_id","kind","attempt"),
	CONSTRAINT "treasury_earn_actions_raw_amount_positive" CHECK ("treasury_earn_actions"."raw_amount" > 0),
	CONSTRAINT "treasury_earn_actions_attempt_positive" CHECK ("treasury_earn_actions"."attempt" > 0),
	CONSTRAINT "treasury_earn_actions_reference_id_length" CHECK (char_length("treasury_earn_actions"."reference_id") <= 64),
	CONSTRAINT "treasury_earn_actions_deposit_has_quote" CHECK (("treasury_earn_actions"."kind"::text = 'deposit') <= ("treasury_earn_actions"."intent_quote_id" IS NOT NULL)),
	CONSTRAINT "treasury_earn_actions_acted_has_action_id" CHECK ("treasury_earn_actions"."status"::text NOT IN ('pending', 'succeeded', 'failed') OR "treasury_earn_actions"."privy_action_id" IS NOT NULL),
	CONSTRAINT "treasury_earn_actions_settled_has_time" CHECK (("treasury_earn_actions"."status"::text IN ('succeeded', 'rejected', 'failed')) = ("treasury_earn_actions"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "treasury_earn_actions" ADD CONSTRAINT "treasury_earn_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_earn_actions" ADD CONSTRAINT "treasury_earn_actions_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_earn_actions" ADD CONSTRAINT "treasury_earn_actions_quote_organization_fk" FOREIGN KEY ("intent_quote_id","organization_id") REFERENCES "public"."intent_quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_reference_id_unique" ON "treasury_earn_actions" USING btree ("reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_privy_action_id_unique" ON "treasury_earn_actions" USING btree ("privy_action_id") WHERE "treasury_earn_actions"."privy_action_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_one_live_per_move" ON "treasury_earn_actions" USING btree ("treasury_move_id") WHERE "treasury_earn_actions"."status" IN ('saved', 'pending');--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_earn_actions_one_deposit_per_quote" ON "treasury_earn_actions" USING btree ("intent_quote_id") WHERE "treasury_earn_actions"."kind" = 'deposit' AND "treasury_earn_actions"."status" IN ('saved', 'pending', 'succeeded');