-- Accountants now sign in, to the web dashboard (spec §4, §6.14), so every
-- membership belongs to a user. Until now an accountant was a membership
-- holding only an email and a name (T13). Each is linked here to the user
-- with that email, created the way an invite creates one when nobody has
-- signed in with it yet; the accountant's first sign-in then claims it. A
-- name already on the user is kept, and statuses don't change. The next
-- migration drops the membership's own email and name and requires user_id.
--
-- A person has one membership per company. An accountant whose email already
-- has a membership in the same company (possible only if one of the two was
-- removed) can't be linked without merging the two rows, which needs a
-- person's judgement, so it stops the deploy instead.
--
-- FORCE row-level security applies to this owner role too, so it is lifted
-- for the backfill alone.
ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM memberships a
    JOIN users u ON u.email = a.email
    JOIN memberships m
      ON m.organization_id = a.organization_id AND m.user_id = u.id
    WHERE a.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'an accountant''s email already has a membership in the same company: merge the two memberships before deploying';
  END IF;
END
$$;
--> statement-breakpoint
INSERT INTO users (email, full_name)
SELECT DISTINCT ON (email) email, full_name
FROM memberships
WHERE user_id IS NULL
ORDER BY email, invited_at DESC NULLS LAST
ON CONFLICT (email) DO UPDATE
  SET full_name = EXCLUDED.full_name, updated_at = now()
  WHERE users.full_name IS NULL;
--> statement-breakpoint
WITH linked AS (
  UPDATE memberships AS m
  SET user_id = u.id, updated_at = now()
  FROM users AS u
  WHERE m.user_id IS NULL AND u.email = m.email
  RETURNING m.id, m.organization_id, m.user_id, m.email, m.role, m.status
)
INSERT INTO audit_log
  (actor_type, actor_id, organization_id, action, entity_type, entity_id, before, after)
SELECT
  'system',
  'accountant-logins-migration',
  organization_id,
  'membership.linked',
  'membership',
  id::text,
  jsonb_build_object('userId', NULL),
  jsonb_build_object('userId', user_id, 'email', email, 'role', role, 'status', status)
FROM linked;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
