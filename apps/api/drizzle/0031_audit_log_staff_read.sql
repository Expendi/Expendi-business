-- Staff read access to the audit log (spec §6.13, §6.15, T27).
--
-- The app role may still only INSERT into audit_log (0003). The staff viewer
-- reads through the SECURITY DEFINER functions below, which return rows and
-- nothing else; no grant here lets any role change an entry, and the
-- append-only trigger still rejects UPDATE, DELETE and TRUNCATE for all.
--
-- organizations is FORCE row-level security, so the owner (which runs these
-- functions) needs its own SELECT policy to name each entry's company, as
-- payouts got in 0012. SELECT only, to the owner only; the app role is
-- unaffected.
CREATE POLICY organizations_owner_reads ON organizations FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
-- Every filter is optional (NULL leaves it out). Dates are Africa/Nairobi
-- calendar days, both inclusive, so the boundaries are Nairobi midnights.
-- Newest first; the next page starts after the cursor's (occurred_at, id).
CREATE FUNCTION staff_search_audit_log(
  filter_organization_id uuid,
  filter_actor_type audit_actor_type,
  filter_actor_id text,
  filter_action text,
  filter_action_prefix text,
  filter_entity_type text,
  filter_entity_id text,
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
    organization_id uuid,
    organization_name text,
    action text,
    entity_type text,
    entity_id text,
    "before" jsonb,
    "after" jsonb,
    request_id text,
    ip text,
    user_agent text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.id, a.occurred_at, a.actor_type, a.actor_id, a.organization_id,
           o.name, a.action, a.entity_type, a.entity_id, a."before", a."after",
           a.request_id, a.ip, a.user_agent
    FROM audit_log a
    LEFT JOIN organizations o ON o.id = a.organization_id
    WHERE (filter_organization_id IS NULL OR a.organization_id = filter_organization_id)
      AND (filter_actor_type IS NULL OR a.actor_type = filter_actor_type)
      AND (filter_actor_id IS NULL OR a.actor_id = filter_actor_id)
      AND (filter_action IS NULL OR a.action = filter_action)
      AND (filter_action_prefix IS NULL OR starts_with(a.action, filter_action_prefix))
      AND (filter_entity_type IS NULL OR a.entity_type = filter_entity_type)
      AND (filter_entity_id IS NULL OR a.entity_id = filter_entity_id)
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
REVOKE ALL ON FUNCTION staff_search_audit_log(uuid, audit_actor_type, text, text, text, text, text, date, date, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_search_audit_log(uuid, audit_actor_type, text, text, text, text, text, date, date, timestamptz, uuid, integer) TO expendi_business_app;
--> statement-breakpoint
-- Actor display names for the viewer. The app role has no grant on
-- staff_users (0021); disabled staff resolve too, since old entries name
-- them. users is readable today, but the staff viewer shouldn't depend on
-- that staying so.
CREATE FUNCTION staff_emails_by_id(staff_user_ids uuid[])
  RETURNS TABLE (staff_user_id uuid, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.id, s.email FROM staff_users s WHERE s.id = ANY (staff_user_ids)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_emails_by_id(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_emails_by_id(uuid[]) TO expendi_business_app;
--> statement-breakpoint
CREATE FUNCTION user_emails_by_id(user_ids uuid[])
  RETURNS TABLE (user_id uuid, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.email FROM users u WHERE u.id = ANY (user_ids)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION user_emails_by_id(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION user_emails_by_id(uuid[]) TO expendi_business_app;
