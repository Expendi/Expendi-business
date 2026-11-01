-- phone_verification_challenges: a person's own payout-number codes (spec
-- §6.18), whichever companies they belong to, so scoped to the user rather
-- than a company. Superseded and used challenges are kept as `expired` or
-- `verified`; the API never deletes a row.
GRANT SELECT, INSERT, UPDATE ON phone_verification_challenges TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE phone_verification_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE phone_verification_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY phone_verification_challenges_own ON phone_verification_challenges FOR ALL
  USING (user_id = (SELECT app_current_user_id()))
  WITH CHECK (user_id = (SELECT app_current_user_id()));
