# Customer spreadsheet imports

## Goal

Ship company-admin imports for paid expenses and unpaid bills, with previews, deduplication, templates and history; deploy the Shanga and customer releases.

## Phases

- [x] Commit and push verified Shanga changes; verify Railway / Ops deployment.
- [x] Extend importer authorization, tenant-scoped provenance/history and historical dates.
- [x] Build customer upload/mapping/review/history flow and entry points.
- [ ] Test authorization, isolation, replay safety and UI; migrate/build/deploy and verify.

## Decisions

- Reuse the transactional importer, not staff impersonation.
- Restrict self-service to company admins and history/bills; keep complex migrations in Ops.
- Keep source files and unrelated UI redesign work out of release commits.
- Preserve original Shanga inputs; no live client data import is authorized by this task.

## Status

Shanga release `c45ea94` is live: Railway `0806fbd0-31d0-4fb7-9577-a8715bed6734` SUCCESS, Ops `dpl_HwhLHSWpFXR89fZuQyu9ELBZDvUG` Ready. Self-service implementation complete; running bounded API regression suite before builds/release.

## Errors resolved

- Changed-file lint preferred nullish fallback in sample labels; fixed.
- Preserved omission of staff-only optional action fields so existing staff import hashes stay compatible.
- Full API run caught two fixtures using unscoped owner access against forced RLS; changed them to tenant-scoped writes/reads. Updated the accountant route inventory to assert the two intentional admin-only import reads while retaining parity checks for every other read.
