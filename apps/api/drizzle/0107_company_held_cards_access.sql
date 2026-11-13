-- Company-held cards (spec §6.20, §6.25): a card with no cardholder, which
-- pays recurring payments. Only the roles that read the whole company, and a
-- scope with no role (a system job, or staff in ops admin), see such a card
-- or its merchants. Everyone else's view of the cards they hold stays as 0068
-- left it, with the API showing them only their own.
--
-- Card purchases keep 0068's company-wide policy: the Card balance, which
-- anyone in the company may read, sums every purchase, a company-held card's
-- included. The API shows an employee only their own purchases, and a
-- company-held card's have no cardholder.
DROP POLICY cards_select ON cards;
--> statement-breakpoint
CREATE POLICY cards_select ON cards FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      NOT company_held
      OR (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint

-- The merchants a company-held card has seen. Nothing here is deleted: a
-- merchant an admin didn't recognise stays blocked on that card.
GRANT SELECT, INSERT, UPDATE ON card_merchants TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE card_merchants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_merchants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY card_merchants_select ON card_merchants FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint
CREATE POLICY card_merchants_insert ON card_merchants FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY card_merchants_update ON card_merchants FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- Sandbox purchases on company-held cards are append-only, like Card loads:
-- the record is what stops the daily job making a second one for a bill.
GRANT SELECT, INSERT ON card_simulations TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE card_simulations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE card_simulations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY card_simulations_select ON card_simulations FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint
CREATE POLICY card_simulations_insert ON card_simulations FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
