# Customer spreadsheet imports

## Goal

Ship company-admin imports for paid expenses and unpaid bills, with previews, deduplication, templates and history; deploy the Shanga and customer releases.

## Phases

- [x] Commit and push verified Shanga changes; verify Railway / Ops deployment.
- [x] Extend importer authorization, tenant-scoped provenance/history and historical dates.
- [x] Build customer upload/mapping/review/history flow and entry points.
- [x] Test authorization, isolation, replay safety and UI; migrate/build/deploy and verify.

## Decisions

- Reuse the transactional importer, not staff impersonation.
- Restrict self-service to company admins and history/bills; keep complex migrations in Ops.
- Keep source files and unrelated UI redesign work out of release commits.
- Preserve original Shanga inputs; no live client data import is authorized by this task.

## Status

Complete. Self-service release `b508d61` is pushed to both repositories and deployed. Exact-commit builds/typechecks passed in a clean worktree with the committed lockfile. Railway deployment `1629e2dd-1924-459b-a242-b1f832ad416b` is SUCCESS; its logs confirm migration completion, API startup and disabled receipt reading. Read-only database verification confirmed migration 0066 (journal row 67), nullable staff/member provenance and all four member RLS policies. Customer web deployment `dpl_2ccyb3EyYkCXJBp2f636DYNk2BR1` and Ops deployment `dpl_33dfapxgho1LALDwx8MPZp81JHVt` are Ready. Public import pages and both Ops hostnames return 200; API health is OK, unauthenticated import requests return 401 and expected customer/Ops CORS headers are present. No client records were imported. See the runbook for test evidence and remaining live-client validation.

## Errors resolved

- Changed-file lint preferred nullish fallback in sample labels; fixed.
- Preserved omission of staff-only optional action fields so existing staff import hashes stay compatible.
- Full API run caught two fixtures using unscoped owner access against forced RLS; changed them to tenant-scoped writes/reads. Updated the accountant route inventory to assert the two intentional admin-only import reads while retaining parity checks for every other read.
