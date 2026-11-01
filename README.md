# Expendi Business

B2B stablecoin finance for African startups: expense management, crypto invoicing, and payroll on stablecoin settlement rails.

## Development

Requires Node 22.21+, pnpm 10 (`corepack enable`), and a local Postgres with trust auth on localhost (Homebrew default).

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

- [Expense MVP spec](docs/expense-mvp-spec.md): agreed scope, flows, data model, and go-live checklist for the expense management MVP.
- [Expense MVP build plan](docs/expense-mvp-build-plan.md): 44 ordered, testable tasks with checkpoints.
- [Build handoffs](docs/handoffs/README.md): one document per phase, with a start prompt for a new session, a QA checklist and handoff notes.
- [Implementation guide](docs/implementation-guide.md): architecture, data models, API design, and roadmap for all three product areas.
