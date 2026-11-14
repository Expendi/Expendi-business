# Confidential-default implementation results

## Scope

Continued Claude session `204f9535-f754-4650-a1ff-cea04ee69490` on branch
`feat/confidential-default`, based on `origin/staging` at `91b73d4`.

Built:

- Gated confidential defaults for new company wallets.
- Readiness checks before activation, including relayer float reservations.
- One-existing-company-per-tick rollout with blocked-candidate rotation.
- Resumable rollback using capped, free `move_out` quotes.
- Ledger-neutral fee-float movement, public deposit classification, and
  persistent opt-out after rollback.
- Database fencing of money-operation admission during rollback, plus stale
  quote-route checks after switching.
- Five-minute quiet period for recently successful exact-output buffers.
- Script status reporting, staff quote label, corrected balance-alert advice.
- Migration 0108, configuration example, decision and operational documentation.

## Verification

Dedicated local database: `expendi_business_test_conf_default`. External
providers were faked. No staging or production state was changed.

| Check                                                                      | Result                                    |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| API non-serial suite, `vitest run --testTimeout 60000 --hookTimeout 60000` | 177 files, 4,258 tests passed             |
| Dedicated rollback/rollout serial suite, final source                      | 16 tests passed                           |
| Complete API serial suite, final source                                    | 44 files, 802 tests passed                |
| Shared package tests                                                       | 18 files, 392 tests passed                |
| Admin app tests                                                            | 13 files, 57 tests passed                 |
| `pnpm turbo run typecheck`                                                 | All 8 tasks passed                        |
| API typecheck after the final buffer-return change                         | Passed                                    |
| API production build                                                       | Passed                                    |
| ESLint on changed API source, tests and scripts                            | Passed                                    |
| ESLint on changed admin and shared files                                   | Passed                                    |
| Prettier on changed TypeScript, Markdown and JSON files                    | Passed after formatting the results table |
| Fresh migration application                                                | Passed through the test harness           |
| Drizzle schema generation                                                  | No schema changes                         |
| `git diff --check`                                                         | Passed                                    |

The initial fresh migration run caught a new-enum comparison needing a text
cast. The first dedicated test run caught fixture funding that added balances
instead of replacing them. Both were corrected. A full serial run overlapped
the addition of the buffer-return check and failed its new assertion. The test
passed on a clean dedicated rerun; the full serial suite then passed on frozen
source (802 tests), removing that ambiguity.

## Review fixes (2026-11-14)

- A new wallet that fails readiness now activates on its company wallet
  instead of staying `creating`; the rollout turns it confidential later.
- A drain whose emptied account holds less float than recorded now finishes
  and writes the difference off (`wallets.confidential_float_written_off_usdc`,
  logged and audited), instead of pausing the company's payments for good.
  Turning off an empty account with a recorded float drains the same way.
- After both: API suite 4,258 passed, serial suite 806 passed, typecheck,
  ESLint and `db:generate` (no schema changes) clean.

## Remaining live work

Deployment and `CONFIDENTIAL_ACCOUNTS_ENABLED` activation are pending.
Complete the outstanding original payment checks and the new C23–C33 checks
in `default-rollout-qa.md`. In particular, move-out, refunds and provider dust
behaviour have not been exercised live.

The earlier session's C1/C2 staging results are historical evidence only.
Changes are uncommitted and have not been pushed.
