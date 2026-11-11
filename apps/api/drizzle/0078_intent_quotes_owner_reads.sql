-- intent_quotes is FORCE row-level security, so the SECURITY DEFINER lookup
-- intent_quotes_to_refresh (owned by the migration role) saw no rows. This
-- lets the owner, and only the owner, read it, as payouts_owner_reads does
-- for the payout lookups. The app role is unaffected.
CREATE POLICY intent_quotes_owner_reads ON intent_quotes FOR SELECT TO CURRENT_USER
  USING (true);
