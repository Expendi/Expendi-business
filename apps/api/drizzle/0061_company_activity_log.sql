-- A company's own activity (spec §6.13, §6.14, T49): its admins and
-- accountants read their company's audit entries in the web dashboard.
--
-- The app role still has no SELECT on audit_log (0003), and
-- staff_search_audit_log (0031) stays the staff viewer's alone. This definer
-- function takes no company ID: it returns only entries of the company in
-- the transaction's context (app.org_id), and only when the caller's role
-- there (app.role) is admin or accountant. An employee, or a transaction
-- with no company in context, gets no rows.
--
-- The request ID, IP and device are left out: entries by Expendi staff and
-- systems are in the company's log too, and those columns are ours.
--
-- Filters are optional (NULL leaves one out). Dates are Africa/Nairobi
-- calendar days, both inclusive. Newest first; the next page starts after
-- the cursor's (occurred_at, id).
CREATE FUNCTION company_activity_log(
  filter_action_prefix text,
  nairobi_date_from date,
  nairobi_date_to date,
  cursor_occurred_at timestamptz,
  cursor_id uuid,
  max_rows integer
)
  RETURNS TABLE (
    id uuid,
    occurred_at timestamptz,
    actor_type audit_actor_type,
    actor_id text,
    action text,
    entity_type text,
    entity_id text,
    "before" jsonb,
    "after" jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.id, a.occurred_at, a.actor_type, a.actor_id, a.action,
           a.entity_type, a.entity_id, a."before", a."after"
    FROM audit_log a
    WHERE a.organization_id = (SELECT app_current_org_id())
      AND (SELECT app_current_role()) IN ('admin', 'accountant')
      AND (filter_action_prefix IS NULL OR starts_with(a.action, filter_action_prefix))
      AND (nairobi_date_from IS NULL
           OR a.occurred_at >= nairobi_date_from::timestamp AT TIME ZONE 'Africa/Nairobi')
      AND (nairobi_date_to IS NULL
           OR a.occurred_at < (nairobi_date_to + 1)::timestamp AT TIME ZONE 'Africa/Nairobi')
      AND (cursor_occurred_at IS NULL
           OR (a.occurred_at, a.id) < (cursor_occurred_at, cursor_id))
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT least(greatest(max_rows, 1), 201)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION company_activity_log(text, date, date, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION company_activity_log(text, date, date, timestamptz, uuid, integer) TO expendi_business_app;
