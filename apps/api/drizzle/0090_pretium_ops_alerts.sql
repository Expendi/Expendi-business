-- Ops alerts for Pretium cash-outs (docs/decisions/pretium-cash-out-provider.md).

-- A payout alert names where to look the payout up at its provider:
-- Paycrest's order, Pretium's transaction, or before Pretium gave one the
-- Base transfer sent to it. Adding output columns changes the function's
-- type, so it is dropped and created again with the same grants.
DROP FUNCTION ops_alert_payouts(timestamptz);
--> statement-breakpoint
CREATE FUNCTION ops_alert_payouts(failed_since timestamptz)
  RETURNS TABLE (
    payout_id uuid,
    organization_id uuid,
    organization_name text,
    status payout_status,
    subject_type payout_subject_type,
    payroll boolean,
    provider payout_provider,
    provider_order_id text,
    tx_hash text,
    failure_reason text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id, o.name, p.status, p.subject_type,
           p.payroll_run_id IS NOT NULL, p.provider, p.provider_order_id,
           p.tx_hash, p.failure_reason
    FROM payouts p
    JOIN organizations o ON o.id = p.organization_id
    WHERE p.status = 'needs_review'
       OR (p.status = 'failed'
           AND p.approved_at IS NOT NULL
           AND p.updated_at >= failed_since)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops_alert_payouts(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_alert_payouts(timestamptz) TO expendi_business_app;
--> statement-breakpoint

-- Seeded as 0063 seeded Paycrest's, so a fresh database counts Pretium's
-- reconciliation job's 5 minutes from now rather than reporting it stopped
-- before it first runs.
INSERT INTO station_heartbeats (job, last_finished_at)
  VALUES ('reconcile-pretium', now())
  ON CONFLICT (job) DO NOTHING;
