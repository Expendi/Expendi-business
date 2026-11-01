# Phase 0 Handoff: Foundation

**Linear:** milestone "Phase 0 · Foundation"

- EXP-272 (T1) Scaffold the monorepo
- EXP-274 (T2) Database and company isolation
- EXP-276 (T3) Audit log
- EXP-277 (T4) Customer login

**Goal:** a monorepo with an API that keeps each company's data separate at the database level, writes an append-only audit log, and accepts Privy phone logins. Every later phase builds on this.

## Start prompt

> Read `docs/handoffs/README.md`, then `docs/handoffs/phase-0-foundation.md`. Build Phase 0 one task at a time, in the order listed, reading each task's Linear issue first. Stop at the checkpoint and go through the QA checklist with me.

## Read first

- **Spec:** §8 (multi-tenancy), §9 (architecture), §10 (data model), §6.13 (audit log)
- **Build plan:** Tasks 1–4
- **Consumer backend** (`/Users/chizaa/Documents/projects/expendi/backend/`), for conventions:
  - `README.md`, `package.json`, `src/config.ts`, `src/server.ts`, `src/runtime.ts`
  - `src/layers/`, `src/middleware/`
  - `src/db/client.ts`, `src/db/migrate.ts`, `src/db/advisory-lock.ts`
  - `src/services/phone-verification/phone-normalization.ts`: port this for normalising Kenyan numbers to E.164

## Where things stand

- `expendi-business` holds docs only: `README.md`, `docs/`. There is no code and no commits yet.
- Toolchain from the frontend monorepo: Node `22.21.x`, pnpm `10.19.x`.

## Decisions to confirm with Dennis before T2 and T4

1. **A new Privy app for Expendi Business** (recommended) instead of reusing the consumer app's. This keeps users, login methods, wallet policies and keys separate. **Decided:** new app.
2. **A new Postgres database** on Railway, separate from the consumer database. **Decided:** new database.

## Tasks, in order

### T1 · EXP-272: Scaffold the monorepo

- Packages: `@expendi-business/api`, `@expendi-business/shared`. The mobile and admin apps come in later phases.
- Copy tsconfig, eslint, prettier and vitest setup from the consumer repos, and keep Effect `Config` for configuration.

### T2 · EXP-274: Database and company isolation

**Gotchas:**

- **Table owners and superusers skip RLS.** Run migrations as an owner role and the app as a separate, non-owner app role. Also set `FORCE ROW LEVEL SECURITY` on tenant tables.
- **Set the company per transaction:** `set_config('app.org_id', <id>, true)`. With pooled connections, a session-level setting would leak one company's ID into the next request.
- **`users` is global**, because one person can belong to many companies. `memberships` and every company-owned table carry `organization_id`.
- **The isolation helper must prove more than happy paths.** It must show that a deliberately unfiltered `SELECT` running as company A returns none of company B's rows.

### T3 · EXP-276: Audit log

- Write each audit entry in the same transaction as the change it records.
- The app role gets INSERT only on `audit_log`, and a trigger rejects UPDATE and DELETE.
- Echo the request ID in an `x-request-id` response header and store it on every entry.

### T4 · EXP-277: Customer login

- Verify Privy access tokens with `@privy-io/node`, which the consumer backend also uses.
- Login is email + passkey (spec §4, changed 2026-11-01). Take the email from the Privy user, lowercase it, and key the user on it so invites can be claimed. The M-Pesa payout phone is not part of login (§6.18, T32).
- `GET /me` returns the user and their memberships.

**Can start in parallel:** T5 (EXP-273, the Privy wallet-policy spike) has no dependencies. See the Phase 1 handoff.

## Environment variables

Secrets are stored in Doppler. Railway sets only `SECRETS_MANAGER=doppler` and `DOPPLER_TOKEN`. Locally, use `apps/api/.env` (copy `.env.example`).

| Name                                             | Where              | Purpose                                                                                         |
| ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------- |
| `SECRETS_MANAGER`, `DOPPLER_TOKEN`               | Railway            | Doppler bootstrap (`DOPPLER_PROJECT`/`DOPPLER_CONFIG` are optional with a scoped service token) |
| `DATABASE_URL`                                   | Doppler            | App login role, a member of `expendi_business_app`; never the table owner                       |
| `DATABASE_URL_MIGRATE`                           | Doppler            | Owner role, used only by `db:migrate` / `migrate`                                               |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`               | Doppler            | The Expendi Business Privy app                                                                  |
| `PRIVY_JWT_VERIFICATION_KEY`                     | Doppler (optional) | Verify tokens locally instead of fetching Privy's JWKS                                          |
| `PORT`                                           | Railway            | API port (default 3000)                                                                         |
| `TEST_DATABASE_URL`, `TEST_DATABASE_URL_MIGRATE` | CI only            | Override the local test database                                                                |

## Exit criteria: Checkpoint A

- Build, typecheck and tests pass
- The isolation helper passes
- The audit log is proven append-only

---

## QA checklist

**Automated**

- [x] On a fresh clone, `pnpm install && pnpm build && pnpm typecheck && pnpm test` passes
- [x] The isolation test passes, including the unfiltered `SELECT` that returns none of company B's rows
- [x] A test proves UPDATE and DELETE on `audit_log` fail
- [x] Tests prove that a missing, invalid or expired token returns 401

**Manual**

- [x] Migrations run on an empty database; running them again changes nothing
- [x] In psql as the app role, `current_user` is neither the table owner nor a superuser
- [x] As the app role, `SELECT * FROM memberships` with no `app.org_id` set returns 0 rows
- [x] `GET /health` returns 200 with an `x-request-id` header
- [ ] Log in with a Privy test email account: `GET /me` returns the user, and calling it again doesn't create a second user row
- [ ] A request naming a company the user doesn't belong to returns 403
- [ ] An audit entry's `request_id` matches the response's `x-request-id`

**Hygiene**

- [x] No `.env` files or keys are tracked (`git status`, `git ls-files`)
- [x] `grep -rnE "as any|@ts-ignore|@ts-expect-error" apps packages` finds nothing
- [ ] EXP-272, 274, 276 and 277 are Done in Linear
- [ ] Checkpoint A reviewed with Dennis

---

## Handoff notes (fill in before ending each session)

- **Status:** T1–T4 are built and their acceptance criteria pass. Phase 0 is waiting on the Checkpoint A review and the three manual QA items that need a real Privy app (see QA results).
- **Built:**
  - **T1:** Turbo + pnpm workspace with `apps/api`, `packages/shared`, and `tooling/{typescript,eslint,prettier}` (the frontend monorepo's layout). Hono + Effect API with `GET /health`. Config goes through Effect `Config`; DB URLs and the Privy secret are `Redacted`. The Doppler secrets bootstrap is ported from `backend/src/secrets/`. The server shuts down cleanly on SIGTERM.
  - **T2:** Drizzle schema for `organizations`, `users`, `memberships`. Migrations `0000_init` and `0001_rls`: group role `expendi_business_app`, least-privilege grants, ENABLE+FORCE RLS, and per-command policies keyed on `app.org_id`/`app.user_id`, set per transaction. The API refuses to start if its DB role is a superuser, has BYPASSRLS, or owns a table. The tenant middleware returns the same 403 for a malformed ID, an unknown company, a non-member, and an invited or removed membership. First company-scoped route: `GET /organizations/:organizationId`. The isolation helpers are `src/__tests__/helpers/isolation.ts` (`expectTableIsolation`, `expectRouteIsolation`).
  - **T3:** `audit_log` with migrations `0002_audit_log` and `0003_audit_log_append_only`. The app role gets INSERT only. A trigger rejects UPDATE, DELETE and TRUNCATE for every role, including the owner. An insert policy stops an entry being attributed to a company not in context. `AuditLog` is an Effect service. Request ID, IP and user agent come from a per-request `RequestMeta` service, so call sites don't pass them. Every response, errors included, carries `x-request-id`.
  - **T4:** `PrivyAuth` port (`@privy-io/node` 0.37). The auth middleware verifies Bearer tokens. The first login reads the Privy email, lowercases it and creates the user exactly once, safe under concurrent requests: it claims an invite-created row by email, otherwise inserts, otherwise uses the row a concurrent request just created. That login is audited (`user.registered` / `user.linked`) in the same transaction. `GET /me` returns the user and their non-removed memberships with company names and roles. The response schema is in `packages/shared`.
  - **Local DB:** `pnpm --filter @expendi-business/api db:setup-local` creates the roles plus the `expendi_business` and `expendi_business_test` databases (idempotent). The test run rebuilds the test schema from the migrations every time.
- **Changes from spec or plan, and why:**
  - **Login is email + passkey, not phone + SMS code** (Dennis, 2026-11-01). Admins control company money, so login moved to a stronger factor, and the same passkey will confirm money actions (§7.3). The M-Pesa payout phone is now a separate field confirmed with a Telnyx Verify SMS code (new §6.18 and Task 32, ported from the consumer backend). Invites go by email. Updated: spec §3–§7, §9, §10, §13, §14; build plan T4, T8, T11, T13, T19, new T32, risks and open questions; Phase 1, 2 and 4 handoffs. Code: migration `0004_users_email_login` (`users.email` unique and lowercased; `users.phone` nullable and set only once confirmed, enforced by a CHECK against `phone_verified_at`). The login flow claims invites by email.
  - **Secrets in Doppler, not Railway variables** (Dennis, 2026-11-01). Rule 8 in the handoffs README and the env table above are updated.
  - **Tooling in `tooling/*` packages, not a root `tsconfig.base.json`.** This copies the frontend monorepo, so the Expo and admin apps port over cleanly later.
  - **RLS SQL is in drizzle custom migrations** (`0001_rls.sql`, `0003_audit_log_append_only.sql`), not `src/db/rls.sql`. It runs in order, through the same migrator.
  - **Request IDs use Hono's built-in `hono/request-id`** instead of a custom middleware file. It echoes a well-formed incoming ID and replaces a malformed one.
  - **Migrations don't run on API start** (the consumer backend auto-migrates). Run `pnpm --filter @expendi-business/api migrate` as the Railway pre-deploy command. The API itself only needs the app role.
  - **`audit_log` is ENABLE but not FORCE RLS.** The app role has no SELECT, so the policy only constrains its inserts. FORCE would have stopped the owner (ops, tests, the T27 viewer) from ever reading the log.
  - **Policies have a user-scope branch.** With no company in context, a user sees only their own memberships and the companies they belong to. `/me` and the tenant middleware need this. With a company in context, it is strictly that company.
  - **Data model nullability:** `memberships.user_id` is nullable, with a CHECK, because accountants have email and no login (§4). `users.privy_user_id` is nullable because invites will create users by email before they log in (T13).
  - **Money is `bigint` in TypeScript** (drizzle `mode: "bigint"`), so mixing money with floats fails to compile. JSON responses and audit `before`/`after` serialise money as decimal strings.
  - **Dependency majors are pinned to the consumer repos:** Effect 3, TypeScript 5.9, Vitest 4, ESLint 9. Effect 4, TS 7, Vitest 5 and ESLint 10 are out but would break porting.
  - **Follow-ups after the scope widened to all company spending (2026-11-01):**
    - **`organizations.payroll_cap_margin_pct`:** default 20, CHECK 0–100. Migration `0005_organizations_payroll_cap_margin`. Spec §7.4 and §10.
    - **`app.role` in the DB scope:** `DbScope` takes the caller's `role`, and `runInScope` sets it transaction-locally next to `app.org_id` and `app.user_id`. `app_current_role()` is in migration `0006_app_role_context`. Company routes pass the tenant (which carries the role), so Phase 2B salary tables can restrict rows to admins in RLS, not only in route checks (spec §4).
    - 8 new tests: the margin default, its range edges, and the role being set, absent and not leaking across pooled connections. That makes 103 tests in total.
- **Environment variables added:** `SECRETS_MANAGER`, `DOPPLER_TOKEN` (+ optional `DOPPLER_PROJECT`/`DOPPLER_CONFIG`), `DATABASE_URL`, `DATABASE_URL_MIGRATE`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, optional `PRIVY_JWT_VERIFICATION_KEY`, `PORT`. Tests read `TEST_DATABASE_URL`/`TEST_DATABASE_URL_MIGRATE` and default to the local setup.
- **Known issues and TODOs:**
  - The payout phone is captured by T32 (Phase 2). Until then `users.phone` is always null, which is fine because T8's QA pays team numbers directly. The old risks (a phone never re-synced from Privy, non-Kenyan login numbers) are gone: the phone no longer comes from login, and T32 accepts only Kenyan numbers.
  - The Linear issue for T32 is now EXP-303.
  - `users` has no RLS (global by design). A route that selects users without a filter could expose phones across companies. Revisit when T13 adds team listing.
  - The client IP is the last `X-Forwarded-For` hop, which assumes exactly one trusted proxy (Railway's edge). Verify on the first deploy.
  - Purging audit entries after 5 years will need an owner-run procedure that disables the trigger. T27's staff viewer needs a read path, either the owner or a dedicated read role.
  - On Railway, `DATABASE_URL_MIGRATE` must be able to `CREATE ROLE` (the `postgres` user can) or `expendi_business_app` must already exist. The app login role is created once by hand: `CREATE ROLE <name> LOGIN PASSWORD '…' IN ROLE expendi_business_app;`.
  - Linear: the session's auto mode blocked moving issues to Done. EXP-272, 274, 276 and 277 need moving by hand.
- **QA results (2026-11-01, Claude, local Postgres 15):**
  - **Automated, all pass:** 95 tests after the switch to email login (91 before it). The fresh-clone simulation (install, build, typecheck, test), lint and format check pass too.
  - **Mutation checks, each re-run to green after reverting:** disabling RLS on `memberships` fails 5 isolation tests. Session-level `set_config` fails the pooled-connection leak test. Dropping the audit triggers fails the 3 owner-role tests. Removing `ON CONFLICT` fails the concurrent-first-login test (re-checked after the switch to email login).
  - **Manual, done:** migrations run twice on an empty DB (second run no-op); the dev DB now has all 5 applied, including `0004_users_email_login`. Checked in psql as `expendi_business_api`: not superuser, no BYPASSRLS, owns no table, `memberships` returns 0 rows. The built server returns `/health` 200 with `x-request-id`, and `/me` and company routes return 401 without a valid token. Started with the owner role's URL, the server exits with code 1.
  - **Manual, not done:** the Privy test-account login, the 403 with a real token, and `request_id` against a real login. These need the new Privy app's credentials. Automated tests cover the same paths: the real SDK verification runs against locally signed JWTs, and the route tests use a fake Privy.
- **Next session starts with:** Dennis creates the Expendi Business Privy app (email login and passkeys enabled, a test email account) and puts `PRIVY_APP_ID`/`PRIVY_APP_SECRET` in Doppler or `apps/api/.env`. Run the three remaining manual QA items, review Checkpoint A, then start Phase 1 with T5 (EXP-273, the Privy wallet-policy spike).
