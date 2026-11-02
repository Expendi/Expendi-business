ALTER TYPE "public"."payout_subject_type" ADD VALUE 'withdrawal';--> statement-breakpoint
DROP INDEX "wallet_transactions_payout_debit_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_payout_debit_unique" ON "wallet_transactions" USING btree ("payout_id") WHERE "wallet_transactions"."type" IN ('payout', 'withdrawal');