-- Alerts to the Expendi team (spec §6.16).

-- ops_alerts: Expendi's own record, across companies. Only work outside any
-- company or user context (the alert job, the webhook routes) sees or
-- writes it, so a customer request can never read another company's
-- alerts. No DELETE: an incident is resolved, never removed.
GRANT SELECT, INSERT, UPDATE ON ops_alerts TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE ops_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ops_alerts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ops_alerts_system_only ON ops_alerts FOR ALL
  USING (
    (SELECT app_current_org_id()) IS NULL
    AND (SELECT app_current_user_id()) IS NULL
  )
  WITH CHECK (
    (SELECT app_current_org_id()) IS NULL
    AND (SELECT app_current_user_id()) IS NULL
  );
--> statement-breakpoint

-- station_heartbeats: job names and times only, nothing about a company.
-- Seeded so a fresh database counts the reconciliation job's 5 minutes
-- from now rather than reporting it stopped before it first runs.
GRANT SELECT, INSERT, UPDATE ON station_heartbeats TO expendi_business_app;
--> statement-breakpoint
INSERT INTO station_heartbeats (job, last_finished_at)
  VALUES ('reconcile-paycrest', now());
--> statement-breakpoint

-- The SECURITY DEFINER functions below run as their owner, which FORCE
-- row-level security also binds. Payouts, organizations and the accounting
-- tables already have owner reads; this adds expenses. The app role is
-- unaffected.
CREATE POLICY expenses_owner_reads ON expenses FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint

-- Payouts ops should hear about: every payout under review, and payouts
-- that failed after approval since `failed_since`. One withdrawn before
-- anyone approved it never tried to move money. No amounts: a payroll
-- payout's amount is a salary.
CREATE FUNCTION ops_alert_payouts(failed_since timestamptz)
  RETURNS TABLE (
    payout_id uuid,
    organization_id uuid,
    organization_name text,
    status payout_status,
    subject_type payout_subject_type,
    payroll boolean,
    provider_order_id text,
    failure_reason text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id, o.name, p.status, p.subject_type,
           p.payroll_run_id IS NOT NULL, p.provider_order_id, p.failure_reason
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

-- Companies with something for the wallet to pay: unpaid claims, or the
-- bills and payroll the reminders job looks at. IDs and names only; the
-- low-balance check reads each one in that company's scope.
CREATE FUNCTION ops_alert_balance_companies()
  RETURNS TABLE (organization_id uuid, organization_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.id, o.name
    FROM organizations o
    WHERE o.id IN (
      SELECT e.organization_id FROM expenses e
        WHERE e.kind = 'claim' AND e.status IN ('submitted', 'payout_failed')
      UNION
      SELECT r.organization_id FROM reminder_companies() r
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops_alert_balance_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_alert_balance_companies() TO expendi_business_app;
--> statement-breakpoint

-- Companies whose Zoho sync is failing (spec §6.17): Zoho rejected the
-- connection, or a sync ran out of retries. Counts only, never an error
-- text or a token.
CREATE FUNCTION ops_alert_zoho_companies()
  RETURNS TABLE (
    organization_id uuid,
    organization_name text,
    needs_reconnect boolean,
    failed_syncs integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.id, o.name,
           EXISTS (
             SELECT 1 FROM accounting_connections c
             WHERE c.organization_id = o.id AND c.status = 'needs_reconnect'
           ),
           (SELECT count(*)::int FROM accounting_syncs s
             WHERE s.organization_id = o.id AND s.status = 'failed')
    FROM organizations o
    WHERE o.id IN (
      SELECT c.organization_id FROM accounting_connections c
        WHERE c.status = 'needs_reconnect'
      UNION
      SELECT s.organization_id FROM accounting_syncs s
        WHERE s.status = 'failed'
    )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops_alert_zoho_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_alert_zoho_companies() TO expendi_business_app;
