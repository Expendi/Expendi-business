-- staff_users: the Expendi team's internal admin accounts (spec §6.15).
-- Global like users, but only the owner role writes it, through
-- scripts/add-staff.ts. The app role gets no grant on the table, so the API
-- can't list staff or add, promote or re-enable anyone. It can only resolve
-- one signed-in email to an active staff member, through this function; a
-- disabled member resolves to nothing whatever the calling code checks.
CREATE FUNCTION active_staff_by_email(lookup_email text)
  RETURNS TABLE (staff_user_id uuid, email text, role staff_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.id, s.email, s.role
    FROM staff_users s
    WHERE s.email = lower(lookup_email) AND s.status = 'active'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION active_staff_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION active_staff_by_email(text) TO expendi_business_app;
