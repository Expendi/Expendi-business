# Expendi Business

B2B stablecoin finance for African startups. The MVP is one app where a Kenyan startup sees and pays all of its spending: staff claims, petty cash, supplier bills, subscriptions and salaries.

The company holds USD as USDC in a wallet Expendi manages. Expendi pays out in KES to M-Pesa numbers, Tills, Paybills and Kenyan bank accounts, or in USDC to wallets. One pilot company goes live first, and any company can sign up from day one.

## Status

_Last updated 2026-11-01 (Phase 1 built)._

| Phase                           | What it covers                                                                      | Status                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0 · Foundation                  | Monorepo, API, per-company data isolation, audit log, login                         | **Built and QA'd.** Checkpoint A review left   |
| 1 · Money path                  | Company wallet, Paycrest payouts to every method, one payout engine, USDC payouts   | **Built and tested.** Checkpoint B (live) left |
| 2 · Claim flow                  | Expo app, sign-up, invites, claims, receipt reading, eTIMS, Approve & pay           | Not started                                    |
| 2B · Spending & payments        | Payees, bills, recurring payments, salaries, petty cash, company spending, overview | Not started                                    |
| 3 · Accountant & internal tools | Monthly export, Zoho Books sync, internal admin app, import, alerts                 | Not started                                    |
| 4 · Pilot launch                | App distribution and go-live with the pilot company                                 | Not started                                    |

### Implemented so far (Phase 0, tasks T1–T4)

- **Monorepo:** Turbo + pnpm, with a Hono + Effect API (`apps/api`) and shared schemas (`packages/shared`). Tooling is copied from the consumer repos.
- **Company isolation:**
  - Drizzle on Postgres, with row-level security per company.
  - The API runs as a restricted database role and refuses to start as an owner or superuser.
  - The company, user and role are set per transaction.
  - An isolation test helper proves one company can't read another's data.
- **Audit log:** append-only, enforced by the database. Updates and deletes are rejected for every role.
- **Login:** Privy email login (passkeys come with the mobile app). `GET /me` returns the user's companies and roles.
- **Secrets:** loaded from Doppler at startup.
- **Ready for the wider scope:** a payroll cap margin on each company, and the caller's role available to database policies, so salaries can be hidden from employees.
- **Tests:** 103, all passing, with build, typecheck, lint and format checks.
- **Manual QA with the real Privy app (2026-11-01):** passed. A real test-account login reaches `GET /me`, gets 403 for another company, and its audit entry carries the response's request ID.

### Implemented so far (Phase 1, tasks T5–T10 and T33)

- **Wallet policies (T5):** Privy can cap USDC transfers, so payouts stay on Paycrest's Sender API (`docs/decisions/privy-wallet-policies.md`). Each company wallet is owned by Expendi's management key; the API only signs, within a policy allowing USDC on Base up to 3,100 USDC per transaction.
- **Wallet and deposits (T6):** one wallet per company, created idempotently. USDC deposits are credited from Base receipts via the Alchemy webhook. The admin-only balance includes the KES equivalent.
- **Paycrest (T7):** exact whole-shilling KES, with USDC rounded up so the recipient is never short. Covers M-Pesa numbers, Tills, Paybills and banks, plus the `order-safety` checks.
- **Payout engine (T8):** one engine for claims, bills, floats and payroll runs. Approval is the admin's passkey, bound to the exact batch. Balance, daily and payroll caps and both pauses are checked under a wallet lock, and each payout is funded once.
- **Webhook and reconciliation (T9):** signed and re-fetched. A minute job with an advisory lock reads Paycrest and updates our records; anything unclear goes to `needs_review`, never re-sent.
- **Refunds and retry (T10):** refunds are credited from the chain, and a retry is a new payout.
- **USDC payouts (T33):** an exact USDC amount to addresses on a passkey-guarded allowlist, confirmed from receipts.
- **Tests:** 328, all passing, with build, typecheck, lint and format checks.

### Up next

1. **Checkpoint B with Dennis:** the live payouts with real money. Follow the runbook in the [Phase 1 handoff](docs/handoffs/phase-1-money-path.md). It needs Alchemy, Paycrest, Base RPC and WebAuthn settings, plus the Privy keys from `scripts/setup-privy-keys.ts`.
2. **Review Checkpoint A** for Phase 0, if it hasn't been done yet.
3. **Finish the Privy setup:** turn on passkeys (Phase 2 login) and gas sponsorship on Base, and put the keys in Doppler for deploys.
4. **Optional parallel work:** the internal admin app (T23) and audit log viewer (T27) only need Phase 0.

**Inputs still needed from Dennis:**

- the pilot's spreadsheet: the header and 3 sample rows from each part
- a Telnyx Verify profile, for confirming payout phone numbers
- a Zoho API client
- the accountant's Zoho account mapping
- the price after the free period

Task status is tracked in the Linear project **Expendi Business**.

## Development

Requires Node 22.21+, pnpm 10 (`corepack enable`), and a local Postgres with trust auth on localhost (the Homebrew default).

```sh
pnpm install
pnpm --filter @expendi-business/api db:setup-local   # once: roles + dev/test databases
cp apps/api/.env.example apps/api/.env               # fill in the Privy app credentials
pnpm --filter @expendi-business/api db:migrate
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @expendi-business/api dev              # API on :3000
```

Deployed secrets live in Doppler; see the [Phase 0 handoff](docs/handoffs/phase-0-foundation.md#environment-variables).

## Docs

- [MVP spec](docs/expense-mvp-spec.md): agreed scope, flows, data model and go-live checklist. It covers all company spending, paid through Expendi.
- [Build plan](docs/expense-mvp-build-plan.md): 44 ordered, testable tasks with checkpoints.
- [Build handoffs](docs/handoffs/README.md): one document per phase, with a start prompt for a new session, a QA checklist and handoff notes.
- [Implementation guide](docs/implementation-guide.md): the original architecture and roadmap for all three product areas. The MVP spec replaces its Part 1.
- [How it works (for clients)](docs/client/how-expendi-business-works.png): a one-page diagram. It shows staff claims only and is due for an update.
