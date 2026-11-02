ALTER TABLE "payouts" ADD COLUMN "gateway_order_id" text;--> statement-breakpoint
CREATE INDEX "payouts_gateway_order_id_idx" ON "payouts" USING btree ("gateway_order_id");--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_gateway_order_id_is_bytes32" CHECK ("payouts"."gateway_order_id" ~ '^0x[0-9a-f]{64}$');