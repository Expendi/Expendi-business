ALTER TYPE "public"."intent_quote_purpose" ADD VALUE 'move_out';--> statement-breakpoint
ALTER TABLE "intent_quotes" DROP CONSTRAINT "intent_quotes_intents_side_matches_purpose";--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD COLUMN "moved_surplus_usdc" bigint;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "balance_home_changing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "confidential_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "confidential_float_written_off_usdc" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "balance_home_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "confidential_rollout_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_move_out_is_free" CHECK ("intent_quotes"."purpose"::text <> 'move_out' OR ("intent_quotes"."deposit_type"::text = 'CONFIDENTIAL_INTENTS' AND "intent_quotes"."recipient_type" = 'DESTINATION_CHAIN' AND "intent_quotes"."swap_type" = 'EXACT_INPUT' AND "intent_quotes"."amount_in" = "intent_quotes"."amount_out" AND "intent_quotes"."recipient" = "intent_quotes"."refund_to"));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_moved_surplus_is_move_out" CHECK ("intent_quotes"."moved_surplus_usdc" IS NULL OR ("intent_quotes"."purpose"::text = 'move_out' AND "intent_quotes"."moved_surplus_usdc" >= 0 AND "intent_quotes"."moved_surplus_usdc" <= "intent_quotes"."amount_in"));--> statement-breakpoint
ALTER TABLE "intent_quotes" ADD CONSTRAINT "intent_quotes_intents_side_matches_purpose" CHECK (("intent_quotes"."deposit_type" = 'INTENTS') = ("intent_quotes"."purpose"::text = 'fund_in_return') AND ("intent_quotes"."deposit_type"::text <> 'CONFIDENTIAL_INTENTS' OR "intent_quotes"."purpose"::text IN ('base_hop', 'usdc_payout', 'to_treasury', 'move_out')) AND ("intent_quotes"."refund_type" <> 'INTENTS' OR "intent_quotes"."purpose"::text IN ('fund_in', 'fund_in_return', 'invoice_payment')) AND (("intent_quotes"."refund_type"::text = 'CONFIDENTIAL_INTENTS') = ("intent_quotes"."deposit_type"::text = 'CONFIDENTIAL_INTENTS')));
--> statement-breakpoint
-- IDs only, then each job works under that company's RLS scope.
CREATE FUNCTION confidential_rollout_candidates(max_rows integer)
RETURNS TABLE (organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.organization_id FROM wallets w
  WHERE w.status = 'active' AND w.chain <> 'base'
    AND w.balance_home = 'company_wallet'
    AND NOT w.confidential_opt_out AND NOT w.balance_home_changing
  ORDER BY w.confidential_rollout_checked_at NULLS FIRST, w.created_at, w.id
  LIMIT greatest(0, least(max_rows, 50))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION confidential_rollout_candidates(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION confidential_rollout_candidates(integer) TO expendi_business_app;
--> statement-breakpoint
CREATE FUNCTION confidential_move_out_wallets()
RETURNS TABLE (organization_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.organization_id FROM wallets w
  WHERE w.status = 'active' AND w.balance_home_changing
  ORDER BY w.created_at, w.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION confidential_move_out_wallets() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION confidential_move_out_wallets() TO expendi_business_app;
--> statement-breakpoint
-- Conservative budget for existing accounts, matching recordedExpendiSurplus.
-- A refill is reserved until it settles, even if it has already left the relayer.
CREATE FUNCTION confidential_rollout_reserve(exclude_wallet uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(greatest(1000000 - (coalesce(f.surplus, 0) - w.confidential_float_written_off_usdc), 0)), 0)
  FROM wallets w
  LEFT JOIN LATERAL (
    SELECT sum(CASE
      WHEN q.purpose::text = 'fee_cover' THEN
        CASE WHEN q.status = 'succeeded' THEN coalesce(q.swapped_amount_out, q.amount_out) ELSE 0 END
      WHEN q.purpose::text = 'move_out' THEN
        CASE WHEN q.status = 'succeeded' THEN -coalesce(q.moved_surplus_usdc, 0) ELSE 0 END
      WHEN q.purpose::text = 'sweep' AND q.recipient_type = 'CONFIDENTIAL_INTENTS' THEN
        CASE WHEN q.status = 'succeeded' THEN -greatest(q.amount_in - coalesce(q.swapped_amount_out, q.amount_out), 0) ELSE 0 END
      WHEN q.purpose::text IN ('base_hop', 'usdc_payout') AND q.deposit_type::text = 'CONFIDENTIAL_INTENTS'
        AND q.deposit_started_at IS NOT NULL THEN -(CASE
          WHEN q.status = 'succeeded' THEN least(greatest(coalesce(q.swapped_amount_in, q.amount_in), q.amount_out), q.amount_in) - q.amount_out
          WHEN q.status = 'refunded' THEN q.amount_in - least(coalesce(q.refunded_amount, q.amount_in), q.amount_in)
          WHEN q.status = 'failed' AND q.company_wallet_send_id IS NULL THEN 0
          ELSE q.amount_in - q.amount_out END)
      ELSE 0 END) AS surplus
    FROM intent_quotes q WHERE q.wallet_id = w.id
  ) f ON true
  WHERE w.id <> exclude_wallet AND w.status = 'active'
    AND w.balance_home = 'confidential_account' AND NOT w.balance_home_changing
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION confidential_rollout_reserve(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION confidential_rollout_reserve(uuid) TO expendi_business_app;
--> statement-breakpoint
-- All admissions take the same wallet lock as a switch. This closes the
-- race between an API request quoting outside a transaction and a rollback.
-- Invoker security: table access still obeys the request's RLS scope.
CREATE FUNCTION guard_balance_home_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE w wallets%ROWTYPE;
BEGIN
  SELECT * INTO w FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF w.balance_home_changing THEN
    IF TG_TABLE_NAME = 'intent_quotes' THEN
      IF NEW.purpose::text = 'move_out' THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'The company account is moving back to its wallet. Try again after the move-out settles.'
      USING ERRCODE = '23514', CONSTRAINT = 'balance_home_transition';
  END IF;
  IF TG_TABLE_NAME = 'intent_quotes' THEN
    IF NEW.purpose::text = 'move_out' THEN
      RAISE EXCEPTION 'A move-out requires a requested balance-home transition'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_home_transition';
    END IF;
    -- Requests that began before a switch must re-quote using the new home.
    IF w.balance_home_changed_at IS NOT NULL THEN
      IF (NEW.purpose::text IN ('fund_in', 'invoice_payment', 'fund_in_return', 'sweep', 'from_treasury', 'move_in', 'fee_cover')
          AND (NEW.recipient_type = 'CONFIDENTIAL_INTENTS') <> (w.balance_home = 'confidential_account'))
        OR (NEW.purpose::text IN ('base_hop', 'usdc_payout', 'to_treasury')
          AND (NEW.deposit_type = 'CONFIDENTIAL_INTENTS') <> (w.balance_home = 'confidential_account')) THEN
        RAISE EXCEPTION 'The company balance home changed. Request a new quote.'
          USING ERRCODE = '23514', CONSTRAINT = 'balance_home_quote_route';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER intent_quotes_balance_home_admission BEFORE INSERT ON intent_quotes
FOR EACH ROW EXECUTE FUNCTION guard_balance_home_admission();
--> statement-breakpoint
CREATE TRIGGER company_sends_balance_home_admission BEFORE INSERT ON company_wallet_sends
FOR EACH ROW EXECUTE FUNCTION guard_balance_home_admission();
--> statement-breakpoint
CREATE TRIGGER treasury_balance_home_admission BEFORE INSERT ON treasury_moves
FOR EACH ROW EXECUTE FUNCTION guard_balance_home_admission();
--> statement-breakpoint
CREATE TRIGGER payouts_balance_home_admission BEFORE INSERT OR UPDATE OF status ON payouts
FOR EACH ROW WHEN (NEW.status IN ('approved', 'order_created', 'funding', 'paying', 'needs_review'))
EXECUTE FUNCTION guard_balance_home_admission();
