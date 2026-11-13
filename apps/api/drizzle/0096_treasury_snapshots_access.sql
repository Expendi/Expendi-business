-- Treasury snapshots (docs/work/treasury/spec.md, "Ledger and data"): one
-- row per company per Nairobi day. No UPDATE and no DELETE: a day's figure is
-- the record of what Privy said, and the day's row is written once.
--
-- Anyone in the company's scope can read, because the Treasury account is
-- shown to admins and accountants and falls back to the latest snapshot; no
-- route shows one to an employee. Only an admin, or a scope with no role (the
-- station job writing it), inserts, as for treasury_moves in 0093.
GRANT SELECT, INSERT ON treasury_snapshots TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE treasury_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE treasury_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY treasury_snapshots_select ON treasury_snapshots FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY treasury_snapshots_insert ON treasury_snapshots FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint

-- The SECURITY DEFINER lookups below are owned by the migration role, which
-- FORCE row-level security still applies to: this lets the owner, and only
-- the owner, read these tables, as treasury_moves_owner_reads does in 0093.
CREATE POLICY treasury_snapshots_owner_reads ON treasury_snapshots FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY treasury_earn_actions_owner_reads ON treasury_earn_actions FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint

-- Companies with Treasury on, for the alert checks. IDs, names and the
-- wallet's address only; each is read in that company's scope.
CREATE FUNCTION treasury_companies()
  RETURNS TABLE (
    organization_id uuid,
    organization_name text,
    treasury_address text,
    treasury_privy_wallet_id text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.organization_id, o.name, w.treasury_address, w.treasury_privy_wallet_id
    FROM wallets w
    JOIN organizations o ON o.id = w.organization_id
    WHERE w.status = 'active'
      AND w.treasury_turned_on_at IS NOT NULL
      AND w.treasury_address IS NOT NULL
      AND w.treasury_privy_wallet_id IS NOT NULL
    ORDER BY w.organization_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION treasury_companies() TO expendi_business_app;
--> statement-breakpoint

-- Companies with Treasury on that have no snapshot for `day` yet, for the
-- treasury-snapshots job, so a run that has nothing to write asks Privy
-- for nothing.
CREATE FUNCTION treasury_snapshot_companies(day date)
  RETURNS TABLE (organization_id uuid, treasury_privy_wallet_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.organization_id, w.treasury_privy_wallet_id
    FROM wallets w
    WHERE w.status = 'active'
      AND w.treasury_turned_on_at IS NOT NULL
      AND w.treasury_privy_wallet_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM treasury_snapshots s
        WHERE s.organization_id = w.organization_id AND s.snapshot_date = day
      )
    ORDER BY w.organization_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_snapshot_companies(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION treasury_snapshot_companies(date) TO expendi_business_app;
--> statement-breakpoint

-- Moves still open or under review that were started before `started_before`:
-- the "move not settled" alert. No quote, hash or address.
CREATE FUNCTION ops_alert_treasury_moves(started_before timestamptz)
  RETURNS TABLE (
    move_id uuid,
    organization_id uuid,
    organization_name text,
    direction text,
    status text,
    requested_usdc bigint,
    started_at timestamptz,
    failure text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.organization_id, o.name, m.direction::text, m.status::text,
           m.requested_usdc, m.created_at, m.failure
    FROM treasury_moves m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.status IN ('open', 'needs_review')
      AND m.created_at < started_before
    ORDER BY m.created_at, m.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops_alert_treasury_moves(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_alert_treasury_moves(timestamptz) TO expendi_business_app;
--> statement-breakpoint

-- Withdrawals the vault filled in part since `since`: what was asked and
-- what its transaction delivered.
CREATE FUNCTION ops_alert_treasury_partial_fills(since timestamptz)
  RETURNS TABLE (
    move_id uuid,
    organization_id uuid,
    organization_name text,
    asked_usdc bigint,
    delivered_usdc bigint
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.treasury_move_id, a.organization_id, o.name, a.raw_amount, a.delivered_usdc
    FROM treasury_earn_actions a
    JOIN organizations o ON o.id = a.organization_id
    WHERE a.kind = 'withdraw'
      AND a.status = 'succeeded'
      AND a.delivered_usdc < a.raw_amount
      AND a.settled_at >= since
    ORDER BY a.settled_at, a.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ops_alert_treasury_partial_fills(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_alert_treasury_partial_fills(timestamptz) TO expendi_business_app;
