-- The staff tools for NEAR Intents quotes under review (spec §6.15,
-- docs/decisions/near-main-chain.md). Staff are never company members, so a
-- list across companies goes through a SECURITY DEFINER lookup, and a view
-- of one quote then runs in that quote's company scope.

-- company_wallet_sends is FORCE row-level security, so the lookup below
-- (owned by the migration role) would see no rows. This lets the owner, and
-- only the owner, read it, as intent_quotes_owner_reads (0078) does. The app
-- role is unaffected.
CREATE POLICY company_wallet_sends_owner_reads ON company_wallet_sends FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint

-- Quotes Expendi pays itself that need a person, from every company (or
-- one), newest first: one under review, and one already settled that still
-- holds a payout under review or a company wallet send nobody closed. A
-- payout is held by its Base hop until it has asked Paycrest for an order,
-- and by its delivery quote throughout. A quote's deposit send has the key
-- `quote:<quote ID>` (services/intents/quote-settle.ts). The next page
-- starts after the cursor's (created_at, id).
CREATE FUNCTION staff_intent_quote_queue(
  filter_organization_id uuid,
  cursor_created_at timestamptz,
  cursor_id uuid,
  max_rows integer
)
  RETURNS TABLE (
    quote_id uuid,
    organization_id uuid,
    organization_name text,
    purpose text,
    status text,
    one_click_status text,
    amount_in numeric,
    amount_out numeric,
    deposit_address text,
    recipient text,
    deadline timestamptz,
    failure text,
    payouts_in_review integer,
    open_sends integer,
    created_at timestamptz,
    updated_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH candidates AS (
      SELECT q.id FROM intent_quotes q WHERE q.status = 'needs_review'
      UNION
      SELECT p.delivery_quote_id FROM payouts p
      WHERE p.status = 'needs_review' AND p.delivery_quote_id IS NOT NULL
      UNION
      SELECT p.base_hop_quote_id FROM payouts p
      WHERE p.status = 'needs_review'
        AND p.base_hop_quote_id IS NOT NULL
        AND p.order_requested_at IS NULL
      UNION
      SELECT q.id FROM company_wallet_sends s
      JOIN intent_quotes q
        ON q.organization_id = s.organization_id
       AND s.send_key = 'quote:' || q.id::text
      WHERE s.status IN ('reserved', 'signed')
    )
    SELECT q.id, q.organization_id, o.name, q.purpose::text, q.status::text,
           q.one_click_status::text, q.amount_in, q.amount_out,
           q.deposit_address, q.recipient, q.deadline, q.failure,
           held.payouts_in_review, sends.open_sends, q.created_at,
           q.updated_at
    FROM candidates c
    JOIN intent_quotes q ON q.id = c.id
    JOIN organizations o ON o.id = q.organization_id
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS payouts_in_review
      FROM payouts p
      WHERE p.organization_id = q.organization_id
        AND p.status = 'needs_review'
        AND ((q.purpose = 'base_hop'
              AND p.base_hop_quote_id = q.id
              AND p.order_requested_at IS NULL)
          OR (q.purpose = 'usdc_payout' AND p.delivery_quote_id = q.id))
    ) held
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS open_sends
      FROM company_wallet_sends s
      WHERE s.organization_id = q.organization_id
        AND s.send_key = 'quote:' || q.id::text
        AND s.status IN ('reserved', 'signed')
    ) sends
    WHERE q.purpose IN ('base_hop', 'usdc_payout', 'sweep')
      AND (q.status = 'needs_review'
           OR (q.status IN ('succeeded', 'refunded')
               AND (held.payouts_in_review > 0 OR sends.open_sends > 0)))
      AND (filter_organization_id IS NULL OR q.organization_id = filter_organization_id)
      AND (cursor_created_at IS NULL
           OR (q.created_at, q.id) < (cursor_created_at, cursor_id))
    ORDER BY q.created_at DESC, q.id DESC
    LIMIT least(greatest(max_rows, 1), 201)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_intent_quote_queue(uuid, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_intent_quote_queue(uuid, timestamptz, uuid, integer) TO expendi_business_app;
--> statement-breakpoint

-- The company a quote belongs to, so a staff view or action on it can run in
-- that company's scope.
CREATE FUNCTION organization_of_intent_quote(target_quote_id uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT q.organization_id FROM intent_quotes q WHERE q.id = target_quote_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION organization_of_intent_quote(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION organization_of_intent_quote(uuid) TO expendi_business_app;
--> statement-breakpoint

-- The payout queue (0037) with the chain of each payout's company wallet, so
-- staff can tell which chain its transaction hash is on. The return type
-- changes, so the function is replaced rather than altered.
DROP FUNCTION staff_payout_queue(payout_status[], uuid, timestamptz, uuid, integer);
--> statement-breakpoint
CREATE FUNCTION staff_payout_queue(
  statuses payout_status[],
  filter_organization_id uuid,
  cursor_created_at timestamptz,
  cursor_id uuid,
  max_rows integer
)
  RETURNS TABLE (
    payout_id uuid,
    organization_id uuid,
    organization_name text,
    wallet_chain text,
    subject_type payout_subject_type,
    subject_id uuid,
    payroll_run_id uuid,
    provider payout_provider,
    method payout_method,
    status payout_status,
    amount_kes bigint,
    amount_to_transfer_usdc bigint,
    provider_order_id text,
    deposit_address text,
    tx_hash text,
    provider_reference text,
    provider_status text,
    provider_checked_at timestamptz,
    failure_reason text,
    funding_started_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id, o.name, w.chain::text, p.subject_type,
           p.subject_id, p.payroll_run_id, p.provider, p.method, p.status,
           p.amount_kes, p.amount_to_transfer_usdc, p.provider_order_id,
           p.deposit_address, p.tx_hash, p.provider_reference,
           p.provider_status, p.provider_checked_at, p.failure_reason,
           p.funding_started_at, p.created_at, p.updated_at
    FROM payouts p
    JOIN organizations o ON o.id = p.organization_id
    JOIN wallets w ON w.id = p.wallet_id
    WHERE p.status = ANY (statuses)
      AND (filter_organization_id IS NULL OR p.organization_id = filter_organization_id)
      AND (cursor_created_at IS NULL
           OR (p.created_at, p.id) < (cursor_created_at, cursor_id))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT least(greatest(max_rows, 1), 201)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_payout_queue(payout_status[], uuid, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_payout_queue(payout_status[], uuid, timestamptz, uuid, integer) TO expendi_business_app;
