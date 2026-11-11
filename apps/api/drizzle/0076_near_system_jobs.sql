-- System-scope lookups for the NEAR jobs (docs/decisions/near-main-chain.md).
-- The app role sees one company at a time, so a job that walks every company
-- first asks one of these for IDs only, then works inside each company's scope.

-- A webhook or indexer knows only the receiving address. This resolves the
-- given addresses, and nothing else, to active wallets, saying whether each
-- matched as the company wallet or as the Base transit wallet.
CREATE FUNCTION wallets_by_receiving_address(addresses text[])
  RETURNS TABLE (
    wallet_id uuid,
    organization_id uuid,
    chain text,
    kind text,
    address text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.organization_id, w.chain::text, 'company', w.address
    FROM wallets w
    WHERE w.status = 'active'
      AND lower(w.address) IN (SELECT lower(a) FROM unnest(addresses) AS a)
    UNION ALL
    SELECT w.id, w.organization_id, w.chain::text, 'transit', w.transit_address
    FROM wallets w
    WHERE w.status = 'active'
      AND w.transit_address IS NOT NULL
      AND lower(w.transit_address) IN (SELECT lower(a) FROM unnest(addresses) AS a)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION wallets_by_receiving_address(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wallets_by_receiving_address(text[]) TO expendi_business_app;
--> statement-breakpoint

-- Every active company wallet on the main chain, for the deposit watcher and
-- the sweep job. Written as "not base" because a migration run cannot name an
-- enum value added earlier in the same transaction.
CREATE FUNCTION active_main_chain_wallets()
  RETURNS TABLE (
    wallet_id uuid,
    organization_id uuid,
    address text,
    transit_address text,
    deposits_resume_token text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.organization_id, w.address, w.transit_address,
           w.deposits_resume_token
    FROM wallets w
    WHERE w.status = 'active' AND w.chain <> 'base'
    ORDER BY w.created_at
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION active_main_chain_wallets() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION active_main_chain_wallets() TO expendi_business_app;
--> statement-breakpoint

-- Unsettled NEAR Intents quotes of the given purposes, from any company,
-- least recently checked first (IDs only; each is refreshed in its company's
-- scope).
CREATE FUNCTION intent_quotes_to_refresh(purposes text[], max_rows integer)
  RETURNS TABLE (quote_id uuid, organization_id uuid, purpose text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT q.id, q.organization_id, q.purpose::text
    FROM intent_quotes q
    WHERE q.status IN ('quoted', 'depositing', 'needs_review')
      AND q.purpose::text = ANY (purposes)
    ORDER BY q.one_click_checked_at NULLS FIRST, q.updated_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION intent_quotes_to_refresh(text[], integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION intent_quotes_to_refresh(text[], integer) TO expendi_business_app;
