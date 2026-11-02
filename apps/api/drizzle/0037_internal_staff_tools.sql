-- The internal admin app's companies, payout queue and pause (spec §6.15,
-- §7.6, T24). Staff are never company members, so nothing here widens a
-- company's row-level security for the app role: cross-company lists come
-- from the SECURITY DEFINER functions below, which return rows only, and a
-- staff view of one company runs in that company's scope in a READ ONLY
-- transaction (services/staff/staff-scope.ts).

-- staff_confirmations: the API writes and reads them, and spends one by
-- setting used_at. Nothing else about a confirmation can change.
GRANT SELECT, INSERT, UPDATE ON staff_confirmations TO expendi_business_app;
--> statement-breakpoint
CREATE FUNCTION staff_confirmations_spend_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a staff confirmation is never removed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.used_at IS NOT NULL
     OR NEW.used_at IS NULL
     OR (NEW.id, NEW.staff_user_id, NEW.purpose, NEW.target, NEW.params,
         NEW.token_hash, NEW.intent_hash, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.staff_user_id, OLD.purpose, OLD.target, OLD.params,
         OLD.token_hash, OLD.intent_hash, OLD.expires_at, OLD.created_at)
  THEN
    RAISE EXCEPTION 'a staff confirmation can only be spent, once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER staff_confirmations_spend_only
  BEFORE UPDATE ON staff_confirmations
  FOR EACH ROW EXECUTE FUNCTION staff_confirmations_spend_only();
--> statement-breakpoint
CREATE TRIGGER staff_confirmations_no_delete
  BEFORE DELETE ON staff_confirmations
  FOR EACH ROW EXECUTE FUNCTION staff_confirmations_spend_only();
--> statement-breakpoint

-- Companies by name (anywhere in it, any case) or exact KRA PIN, by name,
-- optionally only those whose payouts are paused. The next page starts
-- after the cursor's (lower(name), id).
CREATE FUNCTION staff_search_companies(
  search text,
  paused_only boolean,
  cursor_sort_name text,
  cursor_id uuid,
  max_rows integer
)
  RETURNS TABLE (
    organization_id uuid,
    name text,
    sort_name text,
    kra_pin text,
    payouts_paused boolean,
    created_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.id, o.name, lower(o.name), o.kra_pin, o.payouts_paused, o.created_at
    FROM organizations o
    WHERE (search IS NULL
           OR strpos(lower(o.name), lower(search)) > 0
           OR o.kra_pin = upper(search))
      AND (NOT paused_only OR o.payouts_paused)
      AND (cursor_sort_name IS NULL
           OR (lower(o.name), o.id) > (cursor_sort_name, cursor_id))
    ORDER BY lower(o.name), o.id
    LIMIT least(greatest(max_rows, 1), 201)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_search_companies(text, boolean, text, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_search_companies(text, boolean, text, uuid, integer) TO expendi_business_app;
--> statement-breakpoint

-- Payouts in the given statuses from every company (or one), newest first,
-- with what ops need to check them against Paycrest and the chain. The next
-- page starts after the cursor's (created_at, id).
CREATE FUNCTION staff_payout_queue(
  statuses payout_status[],
  filter_organization_id uuid,
  cursor_created_at timestamptz,
  cursor_id uuid,
  max_rows integer
)
  RETURNS TABLE (
    payout_id uuid,
    organization_id uuid,
    organization_name text,
    subject_type payout_subject_type,
    subject_id uuid,
    payroll_run_id uuid,
    provider payout_provider,
    method payout_method,
    status payout_status,
    amount_kes bigint,
    amount_to_transfer_usdc bigint,
    provider_order_id text,
    deposit_address text,
    tx_hash text,
    provider_reference text,
    provider_status text,
    provider_checked_at timestamptz,
    failure_reason text,
    funding_started_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.organization_id, o.name, p.subject_type, p.subject_id,
           p.payroll_run_id, p.provider, p.method, p.status, p.amount_kes,
           p.amount_to_transfer_usdc, p.provider_order_id, p.deposit_address,
           p.tx_hash, p.provider_reference, p.provider_status,
           p.provider_checked_at, p.failure_reason, p.funding_started_at,
           p.created_at, p.updated_at
    FROM payouts p
    JOIN organizations o ON o.id = p.organization_id
    WHERE p.status = ANY (statuses)
      AND (filter_organization_id IS NULL OR p.organization_id = filter_organization_id)
      AND (cursor_created_at IS NULL
           OR (p.created_at, p.id) < (cursor_created_at, cursor_id))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT least(greatest(max_rows, 1), 201)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION staff_payout_queue(payout_status[], uuid, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION staff_payout_queue(payout_status[], uuid, timestamptz, uuid, integer) TO expendi_business_app;
--> statement-breakpoint

-- The company a payout belongs to, so a staff view or action on it can run
-- in that company's scope.
CREATE FUNCTION organization_of_payout(target_payout_id uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.organization_id FROM payouts p WHERE p.id = target_payout_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION organization_of_payout(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION organization_of_payout(uuid) TO expendi_business_app;
--> statement-breakpoint

-- The platform-wide pause (spec §7.6). The app role can only read
-- platform_settings (0010), and this is its one way to write: it toggles
-- that flag and nothing else, only for an active ops admin, only with a
-- written reason, and audits the change in the same transaction.
CREATE FUNCTION set_platform_payouts_paused(
  pause boolean,
  acting_staff_user_id uuid,
  reason text,
  audit_request_id text,
  audit_ip text,
  audit_user_agent text
)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  was_paused boolean;
BEGIN
  PERFORM 1 FROM staff_users s
    WHERE s.id = acting_staff_user_id AND s.status = 'active' AND s.role = 'ops_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only an active ops admin can pause or unpause payouts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF char_length(btrim(coalesce(reason, ''))) < 10 THEN
    RAISE EXCEPTION 'pausing or unpausing payouts needs a written reason'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ps.payouts_paused INTO was_paused
    FROM platform_settings ps WHERE ps.id = 1 FOR UPDATE;
  UPDATE platform_settings
    SET payouts_paused = pause,
        updated_by = 'staff:' || acting_staff_user_id,
        updated_at = now()
    WHERE id = 1;
  INSERT INTO audit_log (actor_type, actor_id, organization_id, action,
                         entity_type, entity_id, "before", "after",
                         request_id, ip, user_agent)
  VALUES ('staff', acting_staff_user_id::text, NULL,
          CASE WHEN pause THEN 'platform.payouts_paused'
               ELSE 'platform.payouts_unpaused' END,
          'platform_settings', '1',
          jsonb_build_object('payoutsPaused', was_paused),
          jsonb_build_object('payoutsPaused', pause, 'reason', btrim(reason)),
          audit_request_id, audit_ip, audit_user_agent);
  RETURN was_paused;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION set_platform_payouts_paused(boolean, uuid, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION set_platform_payouts_paused(boolean, uuid, text, text, text, text) TO expendi_business_app;
