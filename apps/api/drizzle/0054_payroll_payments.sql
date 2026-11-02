ALTER TYPE "public"."webauthn_purpose" ADD VALUE 'change_payroll_margin';--> statement-breakpoint
DROP INDEX "payouts_one_live_per_subject";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "subject_part" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_one_live_per_subject" ON "payouts" USING btree ("organization_id","subject_type","subject_id","subject_part") WHERE "payouts"."status" <> 'failed';--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_subject_part" CHECK ("payouts"."subject_part" >= 1 AND ("payouts"."subject_part" = 1 OR ("payouts"."subject_type" = 'bill' AND "payouts"."payroll_run_id" IS NOT NULL)));