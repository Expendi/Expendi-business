# Confidential-default rollout QA

## Local evidence

`apps/api/src/__tests__/services/confidential-default.serial.test.ts` exercises
the real database, RLS, triggers and lifecycle with fake providers:

- Capped multipart drain, retries and concurrent workers.
- Ledger neutrality, float transfer between surplus calculations, and
  public deposit classification.
- Refunded, uncertain, short and fee-bearing outcomes.
- A five-minute quiet period for recently successful exact-output buffers.
- New-operation fencing during rollback.
- Gated rollout, one company per tick and shared relayer reservations.
- Persistent rollback opt-out and explicit re-enablement.
- New-wallet creation waiting for funding, then resuming activation.

The script and existing payment suites provide additional regression coverage.
Record actual verification commands and results in `implementation-results.md`.

## Deployment

1. Deploy migration `0108_confidential_default.sql` with the environment switch
   absent or false. It adds columns, functions and admission triggers without
   switching companies or transferring money.
2. Confirm the API is healthy and existing public/confidential payments still
   route correctly.
3. Complete outstanding relevant checks from `qa-plan.md` on staging. Its
   original C1/C2 results were reported by the preceding session; C3 was partial.
4. Fund the relayer for float targets and NEAR gas/storage.
5. Set `CONFIDENTIAL_ACCOUNTS_ENABLED=true` in the intended environment and
   restart the API. Expect one existing eligible NEAR company per 30-second
   tick. Legacy Base wallets remain ineligible.

## New live checks — not run

| Check | Action and expected result                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C23   | With the switch off, create a company: wallet remains public; no automatic admission.                                                                                                   |
| C24   | Enable it and create a company with insufficient relayer USDC: wallet activates on its company wallet. Fund the relayer: the rollout turns the same wallet confidential.                |
| C25   | Two idle public companies, budget for one float: only one admits. Confirm no second admission until budget permits. Record audit entries and balances.                                  |
| C26   | Keep a quote or payout open for the oldest candidate: it waits; another eligible company is considered on a later tick.                                                                 |
| C27   | Request turn-off of a funded confidential company including a fee float. Verify new operations wait; public balance rises through capped parts; ledger rows and balance do not change.  |
| C28   | Restart the API after a move-out message is saved. It resumes the same quote/signature, without another debit.                                                                          |
| C29   | Observe the public move-out receipt in the deposit watcher: no new deposit credit. Repeat the watcher after completion.                                                                 |
| C30   | Confirm rollback finishes only at zero confidential balance. The float appears as public surplus, not company funds; any recorded float not found is written off and audited.           |
| C31   | Leave rollout enabled after rollback: the opted-out company stays public. Explicitly turn it on; funding checks apply again.                                                            |
| C32   | Disable the rollout switch during a move-out: the rollback continues, while new admissions stop.                                                                                        |
| C33   | If a refund or review occurs, record it without forcing a replacement transfer. Refund retries wait 30 minutes; review blocks new parts. A provider-refused dust balance stays pending. |

Do not manufacture a provider failure by editing live quote rows. Fake-provider
tests cover failures that cannot be reproduced safely on demand.

## Inspection

Use `scripts/confidential-account.ts status --organization-id <id>` for saved
state, then `scripts/treasury-qa.ts reconcile` for fresh holdings. See
`docs/runbooks/confidential-accounts.md` for complete commands.
