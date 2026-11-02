# Remaining implementation tasks

## Goal

Complete the remaining buildable work in T25, T28 and T29, verify changes, and record the external launch dependencies accurately.

## Phases

- [x] Inspect acceptance criteria and existing services.
- [x] Implement spreadsheet import with dry run, validation, idempotency and audit coverage.
- [x] Complete buildable app-distribution and pilot-launch tooling.
- [x] Run targeted and integrated checks; update handoffs.

## Decisions

- Preserve the unrelated root `task_plan.md` and `notes.md`; keep this session's work here.
- Keep Anthropic receipt reading disabled.
- Do not commit or deploy without a request.
- User subsequently requested committing and pushing these updates; deployment verification remains separate.
- Real pilot data, store approvals and live money/device QA must remain explicit external dependencies.
- User requested an online CSV before supplying client data. Added an original public UKEF fixture and explicitly test-only KES conversion.
- User withdrew the request to share the import flow with the customer web app. Imports remain staff-only.

## Status

Buildable work verified and handoffs updated; included in this release. Client mapping review, deployment verification and real store/device/pilot acceptance remain pending.

## Verification (2026-11-02)

- API main suite: 2,062 tests across 98 files passed with `vitest run --maxWorkers=2` on the dedicated local import test database. Serial suite: 169 tests across 15 files passed.
- Shared suite: 181 passed after the final CSV parser adjustment. Mobile: 272 passed. Web: 153 passed.
- API/admin/web production builds passed; all workspace typechecks passed.
- API/mobile lint and format passed. Import-related admin files passed targeted lint and formatting. Shared lint/format passed.
- Repository-wide lint/format was not green: separately added dashboard/UI scaffold files in admin/web reported lint/format errors during checks (including chart types and the mobile media-query hook). These files were being changed outside this task; no fixes were applied here.
- Release configuration smoke checks: 4 passed. Migration generation reported no schema drift. `git diff --check` passed.
- Following the final empty-cell lint refactor, importer/parser tests passed again (18 tests); API build/typecheck/lint/format passed.

## Resolved verification issues

- Initial typecheck needed the shared package rebuilt after adding exports.
- Import tests initially attempted direct audit reads as the app role; corrected tests to use the existing owner-role audit read pattern.
- Duplicate test used `id` instead of the receipt API's `receiptFileId`; corrected fixture usage.
- The random duplicate-test code could start with a digit, so the SMS parser rejected it before duplicate checking. Prefix it with `S` to consistently generate valid M-Pesa-style codes.
- The first unrestricted full API run overlapped monorepo checks and timed out in multiple unrelated payment/Zoho tests. Isolated Zoho/import tests passed (69); the complete main and serial suites then passed without concurrent builds and with two main-suite workers. Evidence supports resource/concurrency pressure; no timeout increases or product behavior changes were needed.
- Empty CSV cells intentionally use defaults. Added an explicit empty-to-undefined helper to satisfy nullish-coalescing lint without changing that behavior.
