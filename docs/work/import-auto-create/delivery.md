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

## Release

- Feature commit `4e92491` pushed to both repositories. Its clean-worktree build/typecheck passed using the committed lockfile.
- Customer web deployment `dpl_74JEVc9p7Dk5XiNtiUsMac8jUDB1` is Ready at <https://business.expendi.app>. Public import pages return 200 and served JS contains the new creation option and preview section.
- Ops deployment initially hit the existing concurrent Next build/typegen race. Follow-up `3b87e3d` serializes build then typecheck; deployment `dpl_4cykwM9BgfUG8Bej7cifMjstHjLQ` is Ready, with logs confirming both stages succeeded. The custom Ops domain points to this deployment.
- Railway API feature deployment `809a0f70-7b38-4630-8fa6-3563b389e5ad` (`4e92491`) is SUCCESS. Startup logs confirm migrations completed and the server started; receipt reading remains disabled. No new schema migration was needed.
- Post-deployment health returned 200/OK; unauthenticated import preview returned 401 with the expected customer CORS header. No live financial records imported for this change.
