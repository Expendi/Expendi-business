# Findings

- Prior release requires existing active categories for all records and payees for bills.
- Customer imports use signed previews and per-company transactional serialization.
- New UI explicitly opts in with `createMissing`; older clients and Ops retain existing validation behavior.
- New names get deterministic company/type/name-scoped UUIDs, keeping row identity stable across creation and concurrent retries. Existing records retain their IDs and legacy row hashes.
- Only ready rows contribute proposed records. Archived, ambiguous, overlong and renamed deterministic matches report actionable errors.
- Commit locks the organization and reference rows, re-resolves names before verifying the signature, and creates references, financial records and audit events in one transaction. No migration is required.
- Domain name limits: category 60 characters; supplier 120. New categories use normal defaults and new suppliers have no payment details.
