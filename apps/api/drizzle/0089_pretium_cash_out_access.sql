-- Pretium as a second cash-out provider. `pretium` joins payout_provider in
-- 0088, and pending migrations run in one transaction, where Postgres won't
-- read a newly added enum value. A SQL function body is parsed when it is
-- created, so the functions below name the value as
-- 'pretium'::text::payout_provider: the text-to-enum cast is only evaluated
-- when the function runs, long after this transaction commits.

-- The active cash-out provider, chosen by staff for every company at once.
-- Like the pause (0037), the app role can only read platform_settings, and
-- this is its one way to write the provider: only for an active ops admin,
-- only with a written reason, audited in the same transaction. Setting the
-- provider that is already active is allowed and audited, as pausing a
-- paused platform is. Returns the provider that was active.
CREATE FUNCTION set_active_cash_out_provider(
  provider cash_out_provider,
  acting_staff_user_id uuid,
  reason text,
  audit_request_id text,
  audit_ip text,
  audit_user_agent text
)
  RETURNS cash_out_provider
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  was_active cash_out_provider;
BEGIN
  PERFORM 1 FROM staff_users s
    WHERE s.id = acting_staff_user_id AND s.status = 'active' AND s.role = 'ops_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only an active ops admin can change the cash-out provider'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(btrim(coalesce(reason, ''))) < 10 THEN
    RAISE EXCEPTION 'changing the cash-out provider needs a written reason'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ps.active_cash_out_provider INTO was_active
    FROM platform_settings ps WHERE ps.id = 1 FOR UPDATE;
  UPDATE platform_settings
    SET active_cash_out_provider = provider,
        updated_by = 'staff:' || acting_staff_user_id,
        updated_at = now()
    WHERE id = 1;
  INSERT INTO audit_log (actor_type, actor_id, organization_id, action,
                         entity_type, entity_id, "before", "after",
                         request_id, ip, user_agent)
  VALUES ('staff', acting_staff_user_id::text, NULL,
          'platform.cash_out_provider_changed',
          'platform_settings', '1',
          jsonb_build_object('activeCashOutProvider', was_active),
          jsonb_build_object('activeCashOutProvider', provider,
                             'reason', btrim(reason)),
          audit_request_id, audit_ip, audit_user_agent);
  RETURN was_active;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_active_cash_out_provider(cash_out_provider, uuid, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_active_cash_out_provider(cash_out_provider, uuid, text, text, text, text) TO expendi_business_app;
--> statement-breakpoint

-- Cross-company lookups for Pretium's callbacks and the reconciliation job,
-- which start without a company (see 0012). IDs only; the work then runs in
-- the payout's company scope.

-- By the transaction code Pretium returned once told the USDC's hash.
CREATE FUNCTION payout_by_pretium_transaction(transaction_code text)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'pretium'::text::payout_provider
      AND p.provider_order_id = transaction_code
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payout_by_pretium_transaction(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payout_by_pretium_transaction(text) TO expendi_business_app;
--> statement-breakpoint

-- By the hash of the USDC sent to Pretium, for a callback or check that
-- comes before the transaction code is known.
CREATE FUNCTION payout_by_pretium_hash(tx_hash text)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'pretium'::text::payout_provider
      AND p.tx_hash = lower(payout_by_pretium_hash.tx_hash)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payout_by_pretium_hash(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payout_by_pretium_hash(text) TO expendi_business_app;
--> statement-breakpoint

-- By the hash of a refund arriving in a transit wallet.
CREATE FUNCTION payout_by_refund_tx_hash(tx_hash text)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.refund_tx_hash = lower(payout_by_refund_tx_hash.tx_hash)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payout_by_refund_tx_hash(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payout_by_refund_tx_hash(text) TO expendi_business_app;
--> statement-breakpoint

-- Pretium cash-outs with USDC in flight, least recently checked first. One
-- never enters order_created, and an approved one has nothing at Pretium.
CREATE FUNCTION pretium_payouts_to_reconcile(max_rows integer)
  RETURNS TABLE (payout_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id
    FROM payouts p
    WHERE p.provider = 'pretium'::text::payout_provider
      AND p.status IN ('funding', 'paying')
    ORDER BY p.provider_checked_at NULLS FIRST, p.updated_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pretium_payouts_to_reconcile(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pretium_payouts_to_reconcile(integer) TO expendi_business_app;
