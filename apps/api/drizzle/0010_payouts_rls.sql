-- Payouts, approval passkeys and challenges, platform settings (spec §6.7,
-- §7, §8).

-- payouts: company-scoped. No DELETE: a payout is never removed, only
-- moved to `failed` or `needs_review`.
GRANT SELECT, INSERT, UPDATE ON payouts TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payouts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payouts_select ON payouts FOR SELECT
  USING (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY payouts_insert ON payouts FOR INSERT
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint
CREATE POLICY payouts_update ON payouts FOR UPDATE
  USING (organization_id = (SELECT app_current_org_id()))
  WITH CHECK (organization_id = (SELECT app_current_org_id()));
--> statement-breakpoint

-- payroll_runs: salaries are private, so only an admin of the company sees
-- or changes a run (spec §4).
GRANT SELECT, INSERT, UPDATE ON payroll_runs TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_runs_admins ON payroll_runs FOR ALL
  USING (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  )
  WITH CHECK (
    organization_id = (SELECT app_current_org_id())
    AND (SELECT app_current_role()) = 'admin'
  );
--> statement-breakpoint

-- approval_passkeys: a person's own credentials, whichever company they
-- approve for, so scoped to the user rather than the company. The counter
-- and last use are updated on every approval; credentials are never deleted
-- by the API.
GRANT SELECT, INSERT, UPDATE ON approval_passkeys TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE approval_passkeys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_passkeys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY approval_passkeys_own ON approval_passkeys FOR ALL
  USING (user_id = (SELECT app_current_user_id()))
  WITH CHECK (user_id = (SELECT app_current_user_id()));
--> statement-breakpoint

-- webauthn_challenges: the user's own; an approval challenge also belongs
-- to the company in context.
GRANT SELECT, INSERT, UPDATE ON webauthn_challenges TO expendi_business_app;
--> statement-breakpoint
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webauthn_challenges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY webauthn_challenges_own ON webauthn_challenges FOR ALL
  USING (
    user_id = (SELECT app_current_user_id())
    AND (organization_id IS NULL OR organization_id = (SELECT app_current_org_id()))
  )
  WITH CHECK (
    user_id = (SELECT app_current_user_id())
    AND (organization_id IS NULL OR organization_id = (SELECT app_current_org_id()))
  );
--> statement-breakpoint

-- platform_settings: one row, readable by the API; only the Expendi team
-- changes it (internal admin app, T24), never the customer API.
INSERT INTO platform_settings (id, payouts_paused) VALUES (1, false);
--> statement-breakpoint
GRANT SELECT ON platform_settings TO expendi_business_app;
