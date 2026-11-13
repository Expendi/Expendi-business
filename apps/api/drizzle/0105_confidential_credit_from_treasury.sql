-- A Move to wallet into a confidential account is credited at settlement like
-- any other delivery into one (docs/work/confidential-accounts/phase-3-4-design.md,
-- B6 and section C). Same function as 0103, with 'from_treasury' added to the
-- purposes; a sweep, a move-in and a fee cover are still never credited.
CREATE OR REPLACE FUNCTION confidential_quotes_to_credit(max_rows integer)
  RETURNS TABLE (quote_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT q.id, q.organization_id
    FROM intent_quotes q
    WHERE q.recipient_type = 'CONFIDENTIAL_INTENTS'
      AND q.status = 'succeeded'
      AND q.ledger_credited_at IS NULL
      AND q.purpose::text IN ('fund_in', 'invoice_payment', 'fund_in_return', 'from_treasury')
    ORDER BY q.settled_at DESC
    LIMIT max_rows
  $$;
