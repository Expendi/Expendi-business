# Customer spreadsheet imports

## Workflow

Company admins open **Expenses → Import spreadsheet** for paid spending, or **Bills → Import spreadsheet** for unpaid liabilities. Direct routes: `/imports?kind=history` and `/imports?kind=bill`.

1. Choose paid expenses or unpaid bills and download the example CSV if useful. Replace the example row with real data.
2. Upload UTF-8 CSV/TSV, at most 512 KB and 500 non-empty rows. Export Excel workbooks one sheet at a time. Custom headings are supported through column mapping; the Shanga layout additionally handles its template rows.
3. Check suggested column matches. Categories must already exist. Bills need an existing payee, their actual due date and KES amount. USDC-payee bills must be entered manually in USD. Bill references may be mapped (maximum 64 characters).
4. Preview: review every row, exact KES total, duplicates and errors. Fix all errors before proceeding. Select the confirmation checkbox and import.
5. Open Expenses/Bills to see the records. **Import history** shows the uploader, filename, date, counts and per-row results; older runs can be loaded. After a timeout, check history and preview again before retrying.

Only company admins access upload, preview, commit and import history. Accountants and employees cannot import, and cannot fetch another company's imports. Salary schedules, recurring instructions, unpaid claims, payees and opening floats remain available through Ops.

## Record semantics

- Paid expenses are company spending with `source=import`, `kind=company`, `status=recorded`, attributed to the admin who imports them. No membership email column is needed.
- Paid history does not move wallet funds or queue Zoho syncs. Receipts/Drive links in a spreadsheet do not attach evidence; records explicitly state that no receipt was attached.
- Bills remain unpaid, with status derived from their due date. Payment is a separate existing flow, including normal payment authorization. Paid/unpaid columns, when mapped, must agree with the selected record type. Shanga always validates the original Status column.
- Dates accept DD/MM/YYYY or YYYY-MM-DD. The old three-month import cutoff has been removed for both customer and Ops history; future spending is rejected.
- Amounts are decimal KES converted with integer arithmetic; no exchange-rate conversion is performed.
- Exact source-row repeats are skipped, including repeats submitted by another admin. Preserve unique source references. Changing source content creates new input, not an update. Similar manually entered transactions still require human reconciliation.
- Ops historical claims retain their original semantics and member attribution. Use one workflow per dataset rather than importing the same history once as claims and again as company spending.

## Technical and rollout notes

- Customer routes: `GET /organizations/:organizationId/imports`, `GET …/imports/:id`, `POST …/imports/preview`, `POST …/imports/commit`.
- Existing tenant middleware plus an admin-only route guard; service-level role/kind checks and RLS enforce the same boundary.
- Migration `0066_low_matthew_murdock.sql` permits either staff or member provenance (exactly one), uses a composite membership/company foreign key, and adds tenant-admin read/insert policies. Existing staff runs remain valid. It does not modify expense, bill or wallet balances.
- Imports reuse read-only previews, transactional audit and writes, per-company serialization and source deduplication. Preview signatures bind actor, company, filename, layout, input, mapping and resolved record identities; expiration is 30 minutes or API restart.
- Original Shanga release: `c45ea94`, Railway deployment `0806fbd0-31d0-4fb7-9577-a8715bed6734` succeeded; Ops deployment `dpl_HwhLHSWpFXR89fZuQyu9ELBZDvUG` is Ready.
- Self-service release verification/deployment is tracked in `docs/work/customer-imports/task_plan.md`.

## Verification before release

- API main regression: 98 suites covered; the full run passed 96 suites, and the remaining import/accountant suites passed a targeted rerun after fixing RLS-scoped test fixtures and documenting the two intentional admin-only import reads (28 tests in that rerun).
- API serial suite: 169 tests passed. Shared: 187 passed. Web: 161 passed.
- Shared/API/web/admin builds and API/web/admin typechecks passed; changed-file lint and formatting checked. Drizzle reports no schema drift after migration 0066.
- Chromium smoke with mocked HTTP responses exercised real upload, mapping suggestions, preview without commit, confirmation gating, successful commit/history, row-error blocking, accountant restriction and bills entry. Desktop and 390px mobile layouts were inspected; mobile has no page-level horizontal overflow. This is separate from signed-in live-provider testing.

## Deployed — 2026-11-02

- Release `b508d61b8af491be33e4e09cef1420adac884c52` pushed to `Expendi/Expendi-business` and `DennohKim/expendi-admin`. A clean detached worktree passed all seven build/typecheck tasks using the committed lockfile.
- Railway dev API: `1629e2dd-1924-459b-a242-b1f832ad416b` **SUCCESS**. Logs confirm `[migrate] migrations applied` and healthy startup. A read-only database query confirmed migration journal row 67 (`1793643203411`), both actor columns and all four member import policies.
- Customer web: `dpl_2ccyb3EyYkCXJBp2f636DYNk2BR1` **Ready**, published from the clean release worktree to <https://business.expendi.app>. Paid expenses: <https://business.expendi.app/imports?kind=history>; unpaid bills: <https://business.expendi.app/imports?kind=bill>.
- Ops: `dpl_33dfapxgho1LALDwx8MPZp81JHVt` **Ready** at <https://expendibiz-admin.expendi.app> and <https://expendi-admin.vercel.app>. The custom hostname now resolves and serves HTTP 200.
- API health returns 200/OK. Import history, preview and commit require authentication (401 without a token). Customer CORS and both Ops origins pass on their respective API routes.
- Anthropic receipt reading remains disabled, confirmed by deployment startup logs. Authenticated live-client imports and Zoho posting were not exercised by this release verification.

No live client records were imported as part of development or deployment. The provided Shanga inputs still need a populated client export.
