-- Read-only checks to run on a database BEFORE migrations 0101 to 0105.
-- Each line A to J must print 0. Run in a read-only session:
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$URL" -X -v ON_ERROR_STOP=1 -f pre-migration-checks.sql
-- A to G count existing rows the new or replaced checks and the new unique
-- index would reject (new columns taken at their defaults). H to J confirm the
-- database is where the migrations expect it: nothing they create exists yet,
-- and everything they drop does.

\pset format unaligned
\pset tuples_only on
\pset fieldsep ' | '
SELECT 'read-only session', current_setting('transaction_read_only');
SELECT 'migrations applied', count(*) FROM drizzle.__drizzle_migrations;
SELECT 'rows: intent_quotes', count(*) FROM intent_quotes;
SELECT 'rows: wallet_transactions', count(*) FROM wallet_transactions;
SELECT 'rows: wallets', count(*) FROM wallets;

SELECT 'A  wallet_transactions_deposit_has_source would reject', count(*) FROM wallet_transactions
WHERE NOT (type::text <> 'deposit'
  OR (intent_quote_id IS NULL AND tx_hash IS NOT NULL AND log_index IS NOT NULL AND block_number IS NOT NULL)
  OR (intent_quote_id IS NOT NULL AND chain::text <> 'base' AND tx_hash IS NULL AND receipt_id IS NULL AND log_index IS NULL AND transfer_index IS NULL AND block_number IS NULL));

SELECT 'B  wallet_transactions_quote_link_is_treasury would reject', count(*) FROM wallet_transactions
WHERE NOT (((type::text = 'to_treasury') <= (intent_quote_id IS NOT NULL))
  AND (intent_quote_id IS NULL OR type::text IN ('to_treasury', 'from_treasury', 'deposit')));

SELECT 'C  wallet_transactions_near_deposit_has_receipt would reject', count(*) FROM wallet_transactions
WHERE NOT (chain::text = 'base' OR type::text <> 'deposit' OR receipt_id IS NOT NULL OR intent_quote_id IS NOT NULL);

SELECT 'D  duplicate quote-settled credits (unique index would fail)', count(*) FROM (
  SELECT intent_quote_id FROM wallet_transactions
  WHERE intent_quote_id IS NOT NULL AND tx_hash IS NULL AND usdc_amount > 0
  GROUP BY intent_quote_id HAVING count(*) > 1) d;

SELECT 'E  intent_quotes_intents_side_matches_purpose (new form) would reject', count(*) FROM intent_quotes
WHERE NOT (((deposit_type::text = 'INTENTS') = (purpose::text = 'fund_in_return'))
  AND (refund_type::text <> 'INTENTS' OR purpose::text IN ('fund_in', 'fund_in_return', 'invoice_payment')));

SELECT 'F  intent_quotes_expired_never_deposited would reject', count(*) FROM intent_quotes
WHERE status::text = 'expired'
  AND (deposit_started_at IS NOT NULL OR company_wallet_send_id IS NOT NULL OR deposit_tx_hash IS NOT NULL);

SELECT 'G  intent_quotes_send_is_from_company_wallet would reject', count(*) FROM intent_quotes
WHERE company_wallet_send_id IS NOT NULL
  AND purpose::text NOT IN ('base_hop', 'usdc_payout', 'fund_in_return', 'to_treasury', 'move_in');

SELECT 'H  rows already using a value the migrations introduce', count(*) FROM intent_quotes
WHERE deposit_type::text = 'CONFIDENTIAL_INTENTS' OR refund_type::text = 'CONFIDENTIAL_INTENTS'
   OR purpose::text IN ('move_in', 'fee_cover');

SELECT 'I  objects the migrations create that already exist', count(*) FROM (
  SELECT 1 FROM pg_type WHERE typname IN ('wallet_balance_home', 'one_click_recipient_type')
  UNION ALL SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND ((table_name = 'wallets' AND column_name IN ('balance_home', 'confidential_usdc', 'confidential_usdc_read_at'))
      OR (table_name = 'intent_quotes' AND column_name IN ('recipient_type', 'signed_intent', 'intent_hash', 'intent_deadline', 'intent_submitted_at', 'ledger_credited_at')))
  UNION ALL SELECT 1 FROM pg_proc WHERE proname IN ('confidential_account_wallets', 'confidential_quotes_to_credit')) x;

SELECT 'J  constraints the migrations drop that are missing', 6 - count(*) FROM pg_constraint
WHERE conname IN ('intent_quotes_send_is_from_company_wallet', 'intent_quotes_expired_never_deposited',
                  'intent_quotes_intents_side_matches_purpose', 'wallet_transactions_deposit_is_onchain',
                  'wallet_transactions_quote_link_is_treasury', 'wallet_transactions_near_deposit_has_receipt');
