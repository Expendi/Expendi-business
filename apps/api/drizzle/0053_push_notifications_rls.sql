-- Push notifications (spec §6.10, §8).

-- push_tokens: a person's own app installs, whichever companies they belong
-- to, so scoped to the user like approval_passkeys (0010). No DELETE:
-- signing out, or Expo reporting the app gone, sets disabled_at.
GRANT SELECT, INSERT, UPDATE ON push_tokens TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY push_tokens_own ON push_tokens FOR ALL
  USING (user_id = (SELECT app_current_user_id()))
  WITH CHECK (user_id = (SELECT app_current_user_id()));
--> statement-breakpoint

-- notification_outbox: company-scoped. Written in the transaction of the
-- event it reports; read and updated by the sending job in that company's
-- scope. No DELETE: a row stays as the record of what was sent.
GRANT SELECT, INSERT, UPDATE ON notification_outbox TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_outbox_select ON notification_outbox FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY notification_outbox_insert ON notification_outbox FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY notification_outbox_update ON notification_outbox FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- The SECURITY DEFINER functions below run as their owner, the migration
-- role, which FORCE row-level security also binds. These policies give the
-- owner exactly what the functions need; the app role is unaffected.
CREATE POLICY push_tokens_owner_access ON push_tokens FOR ALL TO CURRENT_USER
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY notification_outbox_owner_reads ON notification_outbox FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint

-- Registers this app install's token for the person in context. A token is
-- one install, so if someone else signed in there before, it moves to this
-- person: their row isn't visible to the caller, hence SECURITY DEFINER.
-- Returns true when the token moved from someone else.
CREATE FUNCTION register_push_token(push_token text, device_platform push_platform)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    caller uuid := app_current_user_id();
    previous_owner uuid;
  BEGIN
    IF caller IS NULL THEN
      RAISE EXCEPTION 'register_push_token needs a user in context';
    END IF;
    SELECT t.user_id INTO previous_owner
      FROM push_tokens t WHERE t.token = push_token FOR UPDATE;
    INSERT INTO push_tokens (user_id, token, platform)
      VALUES (caller, push_token, device_platform)
      ON CONFLICT (token) DO UPDATE
        SET user_id = caller,
            platform = EXCLUDED.platform,
            last_seen_at = now(),
            disabled_at = NULL;
    RETURN previous_owner IS NOT NULL AND previous_owner <> caller;
  END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION register_push_token(text, push_platform) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION register_push_token(text, push_platform) TO expendi_business_app;
--> statement-breakpoint

-- The enabled tokens of the given people, for the sending job, which runs
-- in a company's scope without a user. Only people with a membership in
-- the company in context: which of them hear about an event (active, the
-- right role) is the sender's rule, applied before it asks.
CREATE FUNCTION push_tokens_of_members(member_user_ids uuid[])
  RETURNS TABLE (push_token_id uuid, user_id uuid, token text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT t.id, t.user_id, t.token
    FROM push_tokens t
    WHERE t.user_id = ANY (member_user_ids)
      AND t.disabled_at IS NULL
      AND EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.user_id = t.user_id
          AND m.organization_id = app_current_org_id()
      )
    ORDER BY t.user_id, t.created_at
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION push_tokens_of_members(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION push_tokens_of_members(uuid[]) TO expendi_business_app;
--> statement-breakpoint

-- Expo reported these installs gone (DeviceNotRegistered): stop sending to
-- them. A token registered again since the message was sent is a live
-- install and stays. Limited to people in the company in context.
CREATE FUNCTION disable_push_tokens(push_token_ids uuid[], message_sent_at timestamptz)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH disabled AS (
      UPDATE push_tokens t
      SET disabled_at = now()
      WHERE t.id = ANY (push_token_ids)
        AND t.disabled_at IS NULL
        AND t.last_seen_at <= message_sent_at
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.user_id = t.user_id
            AND m.organization_id = app_current_org_id()
        )
      RETURNING 1
    )
    SELECT count(*)::integer FROM disabled
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION disable_push_tokens(uuid[], timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION disable_push_tokens(uuid[], timestamptz) TO expendi_business_app;
--> statement-breakpoint

-- The sending job looks across companies for notifications still to send,
-- least recently tried first. IDs only: each is sent inside its company's
-- scope.
CREATE FUNCTION notifications_to_send(max_rows integer)
  RETURNS TABLE (notification_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT n.id, n.organization_id
    FROM notification_outbox n
    WHERE n.sent_at IS NULL AND n.abandoned_at IS NULL
    ORDER BY n.last_attempt_at NULLS FIRST, n.created_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notifications_to_send(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notifications_to_send(integer) TO expendi_business_app;
--> statement-breakpoint

-- Sent notifications whose Expo receipts are due: Expo has them about 15
-- minutes after sending and keeps them for a day.
CREATE FUNCTION notifications_to_check(max_rows integer)
  RETURNS TABLE (notification_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT n.id, n.organization_id
    FROM notification_outbox n
    WHERE n.tickets IS NOT NULL
      AND n.receipts_checked_at IS NULL
      AND n.sent_at < now() - interval '15 minutes'
      AND n.sent_at > now() - interval '1 day'
    ORDER BY n.sent_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notifications_to_check(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notifications_to_check(integer) TO expendi_business_app;
