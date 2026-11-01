# Expendi Business

B2B stablecoin finance for African startups. The MVP is one app where a Kenyan startup sees and pays all of its spending: staff claims, petty cash, supplier bills, subscriptions and salaries.

The company holds USD as USDC in a wallet Expendi manages. Expendi pays out in KES to M-Pesa numbers, Tills, Paybills and Kenyan bank accounts, or in USDC to wallets. One pilot company goes live first, and any company can sign up from day one.

## Status

_Last updated 2026-11-01._

| Phase                           | What it covers                                                                      | Status                                        |
| ------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| 0 · Foundation                  | Monorepo, API, per-company data isolation, audit log, login                         | **Built.** Waiting on the Checkpoint A review |
| 1 · Money path                  | Company wallet, Paycrest payouts to every method, one payout engine, USDC payouts   | **Next**                                      |
| 2 · Claim flow                  | Expo app, sign-up, invites, claims, receipt reading, eTIMS, Approve & pay           | Not started                                   |
| 2B · Spending & payments        | Payees, bills, recurring payments, salaries, petty cash, company spending, overview | Not started                                   |
| 3 · Accountant & internal tools | Monthly export, Zoho Books sync, internal admin app, import, alerts                 | Not started                                   |
| 4 · Pilot launch                | App distribution and go-live with the pilot company                                 | Not started                                   |

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

### Up next

1. **Create the Expendi Business Privy app** with email login and passkeys, and put its keys in Doppler.
2. **Finish Phase 0:** run the 3 remaining manual checks that need a real Privy login, then review Checkpoint A.
3. **Start Phase 1 with T5:** check what Privy wallet policies can enforce. Use the start prompt in the [Phase 1 handoff](docs/handoffs/phase-1-money-path.md).
4. **Optional parallel work:** the internal admin app (T23) and audit log viewer (T27) only need Phase 0, so another session can build them alongside Phase 1.

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
