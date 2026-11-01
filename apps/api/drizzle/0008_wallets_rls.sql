-- Company wallets and their ledger (spec §6.9, §7.1, §8).

-- wallets: the API reads and creates its company's wallet, and fills in the
-- Privy IDs as creation completes. No DELETE: a wallet is never removed.
GRANT SELECT, INSERT, UPDATE ON wallets TO expendi_business_app;
--> statement-breakpoint
-- Not FORCEd, like audit_log: the owner runs the deposit lookup below, which
-- has to find a wallet by address before any company is known. The app role
-- is never the owner, so RLS always applies to it.
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY wallets_select ON wallets FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY wallets_insert ON wallets FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY wallets_update ON wallets FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- The deposit webhook knows only the receiving address. This resolves the
-- given addresses, and nothing else, to their companies' active wallets, so
-- the webhook can then credit each one inside that company's scope.
CREATE FUNCTION active_wallets_by_address(addresses text[])
  RETURNS TABLE (wallet_id uuid, organization_id uuid, address text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT w.id, w.organization_id, w.address
    FROM wallets w
    WHERE w.status = 'active'
      AND lower(w.address) IN (SELECT lower(a) FROM unnest(addresses) AS a)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION active_wallets_by_address(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION active_wallets_by_address(text[]) TO expendi_business_app;
--> statement-breakpoint

-- wallet_transactions: append-only, like audit_log. The app role may read
-- and insert its company's rows; a trigger rejects any change for every
-- role, the owner included. A correction is a new row.
GRANT SELECT, INSERT ON wallet_transactions TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE wallet_transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY wallet_transactions_select ON wallet_transactions FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY wallet_transactions_insert ON wallet_transactions FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE FUNCTION wallet_transactions_reject_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_transactions_no_update_or_delete
  BEFORE UPDATE OR DELETE ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION wallet_transactions_reject_change();
--> statement-breakpoint
CREATE TRIGGER wallet_transactions_no_truncate
  BEFORE TRUNCATE ON wallet_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION wallet_transactions_reject_change();
