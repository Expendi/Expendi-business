-- The admin app's alerts and system health pages (spec §6.16, T26). Both
-- only read: alerts open and resolve on their own, and staff never change
-- one. station_heartbeats is already readable (0063).
--
-- staff_ops_alerts runs as the owner, and FORCE row-level security binds
-- the owner to ops_alerts_system_only as it binds the app role: no owner
-- policy is added, so it returns incidents only to work with no company or
-- user in context, as the staff routes' read scope is. From a customer's
-- request it returns nothing. The organizations owner read (0031) names
-- each incident's company.
--
-- Open incidents come first, newest first, then resolved ones (all of them,
-- or those resolved since `resolved_since`), most recently resolved first.
CREATE FUNCTION staff_ops_alerts(
  filter_kind ops_alert_kind,
  resolved_since timestamptz,
  max_rows integer
)
  RETURNS TABLE (
    alert_id uuid,
    kind ops_alert_kind,
    subject_key text,
    organization_id uuid,
    organization_name text,
    title text,
    details jsonb,
    occurrences integer,
    opened_at timestamptz,
    last_seen_at timestamptz,
    resolved_at timestamptz,
    notified_at timestamptz,
    notify_attempts integer,
    next_notify_at timestamptz,
    last_notify_error text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.id, a.kind, a.subject_key, a.organization_id, o.name, a.title,
           a.details, a.occurrences, a.opened_at, a.last_seen_at,
           a.resolved_at, a.notified_at, a.notify_attempts, a.next_notify_at,
           a.last_notify_error
    FROM ops_alerts a
    LEFT JOIN organizations o ON o.id = a.organization_id
    WHERE (filter_kind IS NULL OR a.kind = filter_kind)
      AND (a.resolved_at IS NULL
           OR resolved_since IS NULL
           OR a.resolved_at >= resolved_since)
    ORDER BY a.resolved_at IS NULL DESC, a.resolved_at DESC,
             a.opened_at DESC, a.id DESC
    LIMIT least(greatest(max_rows, 1), 201)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_ops_alerts(ops_alert_kind, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_ops_alerts(ops_alert_kind, timestamptz, integer) TO expendi_business_app;
