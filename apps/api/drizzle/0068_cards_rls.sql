-- Expendi cards (spec §6.25): company-scoped. Card loads are append-only;
-- nothing else here is deleted through the API. Which cards and purchases an
-- employee sees (only their own) is enforced by the API on top of these.
GRANT SELECT, INSERT, UPDATE ON card_programs TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE card_programs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_programs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY card_programs_select ON card_programs FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY card_programs_insert ON card_programs FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY card_programs_update ON card_programs FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON cardholders TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE cardholders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cardholders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY cardholders_select ON cardholders FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY cardholders_insert ON cardholders FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY cardholders_update ON cardholders FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON cards TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cards FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY cards_select ON cards FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY cards_insert ON cards FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY cards_update ON cards FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

GRANT SELECT, INSERT ON card_loads TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE card_loads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_loads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY card_loads_select ON card_loads FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY card_loads_insert ON card_loads FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON card_purchases TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE card_purchases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_purchases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY card_purchases_select ON card_purchases FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY card_purchases_insert ON card_purchases FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY card_purchases_update ON card_purchases FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- Narrow cross-company lookups for work that starts without a company:
-- Lithic's events and authorization requests name only a card or transaction,
-- and the reconcile job looks across companies. Each returns IDs only; the
-- work then runs inside that company's scope.
CREATE POLICY cards_owner_reads ON cards FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE POLICY card_purchases_owner_reads ON card_purchases FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION card_by_lithic_token(card_token text)
  RETURNS TABLE (card_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.organization_id
    FROM cards c
    WHERE c.lithic_card_token = card_token
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION card_by_lithic_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION card_by_lithic_token(text) TO expendi_business_app;
--> statement-breakpoint
-- Cards a leaver still holds, oldest request first.
CREATE FUNCTION cards_to_close(max_rows integer)
  RETURNS TABLE (card_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.organization_id
    FROM cards c
    WHERE c.close_requested_at IS NOT NULL AND c.state <> 'closed'
    ORDER BY c.close_requested_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION cards_to_close(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cards_to_close(integer) TO expendi_business_app;
--> statement-breakpoint
-- Purchases still moving, or settled with no Card expense yet, stalest first.
CREATE FUNCTION card_purchases_to_reconcile(max_rows integer)
  RETURNS TABLE (organization_id uuid, transaction_token text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.organization_id, p.lithic_transaction_token
    FROM card_purchases p
    WHERE p.status = 'pending'
       OR p.hold_usd_cents > 0
       OR (p.kind = 'purchase' AND p.status = 'settled' AND p.expense_id IS NULL)
    ORDER BY p.updated_at
    LIMIT max_rows
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION card_purchases_to_reconcile(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION card_purchases_to_reconcile(integer) TO expendi_business_app;
