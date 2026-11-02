# Remaining tasks: findings

- T25 spreadsheet import is implemented; pilot-specific column mapping awaits a real sample. Original UKEF fixture exercises 25 real public payments locally with a documented synthetic currency conversion.
- T28 requires production builds, production OTA channel, store testing and final artwork.
- T29 is a real-world launch checklist and 30-day review, not just a code task.
- Privy passkey authentication was verified enabled on 2026-11-02; browser/device success is still unverified.
- Migration 0065 adds immutable import runs/row hashes and float opening totals, with scoped RLS and no update/delete grants.
- No imported payee has a payment method; ordinary admin passkey setup is required before payment. No import creates a payout, wallet transaction or accounting sync.
- Read-only previews return a 30-minute process-signed token; API restart/another replica requires a new preview.
- T28 production Android AAB + Play internal submission profile and production-environment OTA commands are configured; production env checks run after EAS install.
