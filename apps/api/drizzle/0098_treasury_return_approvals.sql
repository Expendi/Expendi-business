CREATE TABLE "treasury_return_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"treasury_move_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"approved_usdc" bigint NOT NULL,
	"approved_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "treasury_return_approvals_kind" CHECK ("treasury_return_approvals"."kind" IN ('return_stranded_deposit', 'resume_return')),
	CONSTRAINT "treasury_return_approvals_amount_positive" CHECK ("treasury_return_approvals"."approved_usdc" > 0)
);
--> statement-breakpoint
ALTER TABLE "treasury_return_approvals" ADD CONSTRAINT "treasury_return_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_return_approvals" ADD CONSTRAINT "treasury_return_approvals_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_return_approvals" ADD CONSTRAINT "treasury_return_approvals_confirmation_id_staff_confirmations_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."staff_confirmations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_return_approvals" ADD CONSTRAINT "treasury_return_approvals_move_organization_fk" FOREIGN KEY ("treasury_move_id","organization_id") REFERENCES "public"."treasury_moves"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_return_approvals_one_pending_per_move" ON "treasury_return_approvals" USING btree ("treasury_move_id") WHERE "treasury_return_approvals"."consumed_at" IS NULL;