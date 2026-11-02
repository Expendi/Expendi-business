CREATE POLICY accounting_syncs_owner_reads ON accounting_syncs
  FOR SELECT TO CURRENT_USER USING (true);
--> statement-breakpoint
CREATE FUNCTION accounting_syncs_due(max_rows integer)
  RETURNS TABLE (sync_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.id, s.organization_id
    FROM accounting_syncs s
    JOIN accounting_connections c ON c.organization_id = s.organization_id AND c.status = 'active'
    WHERE s.status = 'pending' AND s.next_attempt_at <= now()
    ORDER BY s.next_attempt_at, s.id
    LIMIT greatest(0, least(max_rows, 200))
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accounting_syncs_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION accounting_syncs_due(integer) TO expendi_business_app;
