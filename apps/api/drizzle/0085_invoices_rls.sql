-- Crypto invoicing (docs/decisions/crypto-invoicing.md). Admins write and
-- accountants read; employees see none. The routes admit only those roles,
-- and this makes an employee's transaction see no invoices even if a route
-- forgets.
--
-- A scope with no role is a system job acting for no person: the deposit
-- watcher records an invoice paid through its pay link, and the public pay
-- routes (which know only a public ID) read an invoice. They get what that
-- needs and nothing more: read everything below, update invoices, and
-- insert `link` payments. Like payouts' policies in 0045, `role IS NULL`
-- means the system; a missing company still matches nothing.

-- customers: archived, never deleted.
GRANT SELECT, INSERT ON customers TO expendi_business_app;
--> statement-breakpoint
GRANT UPDATE (name, email, address, tax_id, archived_at, updated_at) ON customers TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY customers_select ON customers FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) IN ('admin', 'accountant')
  );
--> statement-breakpoint
CREATE POLICY customers_insert ON customers FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY customers_update ON customers FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint

-- invoices: only a draft is deleted, and the policy says so. A sent
-- invoice's other fields are locked by the service, not by a policy: the
-- watcher must still move an open or void invoice to paid.
GRANT SELECT, INSERT, DELETE ON invoices TO expendi_business_app;
--> statement-breakpoint
GRANT UPDATE (
  customer_id, number, status, terms, issue_on, due_on, tax_rate_bps,
  tax_label, subtotal_cents, tax_cents, total_cents, note, bill_to,
  from_party, public_id, sent_at, paid_at, voided_at, voided_reason,
  voided_by, updated_at
) ON invoices TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint
CREATE POLICY invoices_insert ON invoices FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint
CREATE POLICY invoices_update ON invoices FOR UPDATE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) = 'admin'
    )
  );
--> statement-breakpoint
CREATE POLICY invoices_delete ON invoices FOR DELETE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
    AND status = 'draft'
  );
--> statement-breakpoint

-- Lines change only while their invoice is a draft; deleting the draft
-- removes them through the foreign key's cascade.
GRANT SELECT, INSERT, DELETE ON invoice_line_items TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_line_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_line_items_select ON invoice_line_items FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint
CREATE POLICY invoice_line_items_insert ON invoice_line_items FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
    AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_id
        AND i.organization_id = invoice_line_items.organization_id
        AND i.status = 'draft'
    )
  );
--> statement-breakpoint
CREATE POLICY invoice_line_items_delete ON invoice_line_items FOR DELETE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
    AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = invoice_id
        AND i.organization_id = invoice_line_items.organization_id
        AND i.status = 'draft'
    )
  );
--> statement-breakpoint

-- Payments are never updated. The watcher inserts `link` payments; an admin
-- inserts any kind and deletes only the ones recorded by hand. A link
-- payment can't be removed: that money arrived for this invoice.
GRANT SELECT, INSERT, DELETE ON invoice_payments TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoice_payments_select ON invoice_payments FOR SELECT
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) IS NULL
      OR (SELECT app_current_role()) IN ('admin', 'accountant')
    )
  );
--> statement-breakpoint
CREATE POLICY invoice_payments_insert ON invoice_payments FOR INSERT
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (
      (SELECT app_current_role()) = 'admin'
      OR ((SELECT app_current_role()) IS NULL AND kind = 'link')
    )
  );
--> statement-breakpoint
CREATE POLICY invoice_payments_delete ON invoice_payments FOR DELETE
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
    AND kind IN ('outside', 'matched')
  );
--> statement-breakpoint

-- A pay link carries only its public ID, so no company is in context when
-- it arrives. This resolves the ID to the one invoice it opens and nothing
-- more; 32 random bytes can't be guessed, so it can't list invoices. Callers
-- then read the invoice in that company's scope with no role. invoices is
-- FORCE row-level security, so the owner needs a read policy for this
-- SECURITY DEFINER function, as in 0060.
CREATE POLICY invoices_owner_reads ON invoices FOR SELECT TO CURRENT_USER
  USING (true);
--> statement-breakpoint
CREATE FUNCTION invoice_by_public_id(public_id text)
  RETURNS TABLE (invoice_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.organization_id
    FROM invoices i
    WHERE i.public_id = invoice_by_public_id.public_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invoice_by_public_id(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invoice_by_public_id(text) TO expendi_business_app;
