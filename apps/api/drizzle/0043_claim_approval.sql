ALTER TABLE "expenses" ADD COLUMN "self_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payout_organization_fk" FOREIGN KEY ("payout_id","organization_id") REFERENCES "public"."payouts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_payout_id_unique" ON "expenses" USING btree ("payout_id") WHERE "expenses"."payout_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_self_approval_is_approved" CHECK (NOT "expenses"."self_approved" OR "expenses"."approved_by" IS NOT NULL);