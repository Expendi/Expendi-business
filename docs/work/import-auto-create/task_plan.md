# Import supplier and category creation

## Goal

Company-admin imports match existing names and preview missing suppliers/categories for transactional creation on confirmation.

## Phases

- [x] Inspect importer, authorization, UI and current working changes.
- [x] Implement deterministic preview planning, atomic audited creation and safe retries.
- [x] Show proposed creation in preview and update instructions.
- [ ] Verify integration tests, UI and builds; record delivery.

## Decisions

- Paid expenses need categories; unpaid bills need categories and supplier payees.
- Preview is read-only. Confirmation creates all required records atomically.
- New suppliers have no payment details. Ambiguous active names remain errors.
- Preserve existing import identities and unrelated user work.

## Status

Implementation, tests, browser smoke and builds passed. Preparing an isolated release and verifying deployment.

## Verification notes

- All seven API/web/admin build/typecheck tasks passed; shared tests passed (187).
- Browser smoke initially used an exact-text selector for a result cell that now includes the created category. Updated the selector and added an assertion for the history provenance text.
- Ops deployment exposed an existing build/typegen race: parallel tasks collided on `.next/types/routes.d.ts` (ENOENT). The Vercel log directly identifies concurrent writers, so a broader bug-search loop is unnecessary; serialize build then typecheck and verify the actual deployment pipeline.
