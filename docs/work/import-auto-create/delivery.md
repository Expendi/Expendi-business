# Delivery

Implemented customer-import creation of missing suppliers and categories.

- Existing active names match case-insensitively, ignoring surrounding spaces.
- The default-on creation option explicitly opts in; disabling it preserves existing-only validation.
- Preview lists unique proposed names and identifies them per source row. Nothing is saved until confirmation.
- Confirmation creates master records, bills/expenses and audits atomically. New suppliers have no payment details. Paid expenses create categories only.
- Archived/ambiguous/overlong names and renamed imported references require correction; intervening identity changes require a new preview.
- Stable reference IDs preserve existing source deduplication, including concurrent confirmation retries. History includes created names.

## Verification

- API import/parser/accountant suites: 43 passed, including atomic rollback, no preview writes, concurrent retries, tenant isolation, stale preview rejection and legacy Ops behavior.
- Web suite: 162 passed. Shared suite: 187 passed.
- API/web/admin builds and typechecks: all seven tasks passed.
- Changed API/web lint passed.
- Chromium mocked-HTTP smoke passed: creation summaries, opt-out errors, preview invalidation, confirmation gating, history provenance, accountant restriction, bill mappings and 390px reflow. Mobile screenshot inspected.

Release/deployment pending. No live financial records imported for this change.
