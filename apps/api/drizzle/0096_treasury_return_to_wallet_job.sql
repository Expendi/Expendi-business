-- A move to the wallet (docs/work/treasury/spec.md, section 4): the job now
-- advances moves in both directions, and a withdrawal records what its
-- transaction delivered to the Treasury wallet.

-- Saved once, after the withdrawal succeeds, from the transaction's logs.
GRANT UPDATE (delivered_usdc) ON treasury_earn_actions TO expendi_business_app;
--> statement-breakpoint

-- Open moves of either direction from any company, least recently moved
-- first (IDs only; each is advanced in its company's scope), for the
-- treasury-moves station job.
CREATE OR REPLACE FUNCTION treasury_moves_to_advance(max_rows integer)
  RETURNS TABLE (move_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.organization_id
    FROM treasury_moves m
    WHERE m.status = 'open'
    ORDER BY m.updated_at, m.id
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_moves_to_advance(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION treasury_moves_to_advance(integer) TO expendi_business_app;
