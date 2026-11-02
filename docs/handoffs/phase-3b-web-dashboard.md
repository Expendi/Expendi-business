# Phase 3B Handoff: Web dashboard

**Linear:** milestone "Phase 3B · Web dashboard"

- EXP-316 (T45) Web dashboard scaffold, sign-in and hosting
- EXP-317 (T46) Accountant access
- EXP-318 (T47) Expenses and approvals on the web
- EXP-319 (T48) Bills, recurring payments, payees and payroll on the web
- EXP-320 (T49) Wallet, team, settings and activity on the web
- EXP-321 (T50) Spending overview on the web
- EXP-322 (T51) Accountant downloads and the eTIMS report

**Goal:** company admins and accountants use Expendi Business from a browser at `https://business.expendi.app`:

- admins do everything the app does on a bigger screen, including approving and paying several claims at once with their passkey
- accountants get a view-only login: they see everything, salaries included, can't change anything, and download the export and an eTIMS report

Added to the MVP by Dennis on 2026-11-02 (spec §6.14). It runs in parallel with Phases 2B and 3.

## Start prompt

> Read `docs/handoffs/README.md`, the Handoff notes in `docs/handoffs/phase-2-claim-flow.md`, `docs/handoffs/phase-2b-spending-and-payments.md` and `docs/handoffs/phase-3-accountant-and-internal-tools.md`, then `docs/handoffs/phase-3b-web-dashboard.md`. Build Phase 3B one task at a time, in the order listed, reading each task's Linear issue first. Stop at Checkpoint D2 and go through the QA checklist with me.

## Read first

- **Spec:** §4 (roles), §6.14 (web dashboard), §6.11 (export), §6.13 (audit log), §6.24 (overview), §7 (money safety), §13 item 17
- **Build plan:** Tasks 45–51 and Checkpoint D2
- **This repo:**
  - `apps/admin`: the Next.js structure, Privy login, API client and tooling to copy
  - `apps/mobile/src/features/approval/`: how the app runs a passkey approval (the same API calls on the web)
  - `apps/web/public/.well-known/`: the passkey association files the site must serve
  - `apps/api/src/middleware/admin-app-cors.ts`: the CORS pattern for `/internal`, to mirror for customer routes
  - `apps/api/src/__tests__/routes/internal-routes.test.ts`: the route-listing test to copy for "accountants can't act"

## Where things stand

The API the app uses already serves almost all of this:

- **Company-scoped routes:** every route is role-checked and has an isolation test.
- **Money approvals:** the passkey approval API (claims, withdrawals, payees; bills and payroll as T37/T39 land).
- **Shared types** in `packages/shared`.

The new API work:

- CORS for the dashboard origin
- accountant logins and read-only access
- an all-expenses list
- category editing
- the company's own activity log
- the eTIMS report

## Decisions (Dennis, 2026-11-02)

1. **Accountants see everything, read-only**, salaries and payroll runs included, since the monthly export already contains them.
2. **Hosting:** Vercel at `business.expendi.app`. The same site serves the passkey association files, so the passkey domain (WebAuthn RP ID) and the dashboard are one site.
3. **Timing:** a new phase that starts now, in parallel. Screens that sit on unfinished APIs wait for them.

## Inputs needed from Dennis

1. **Vercel:** a project for `apps/web` and DNS for `business.expendi.app` pointing at it.
2. **Privy dashboard:** add `https://business.expendi.app` (and `http://localhost:3002` for local work) as allowed origins.
3. **Doppler (API):**
   - `DASHBOARD_ORIGINS=https://business.expendi.app`
   - add `https://business.expendi.app` to `WEBAUTHN_ORIGINS`
4. **Android signing fingerprint:** from the first EAS build. It goes into `assetlinks.json` (and the `android:apk-key-hash` entry in `WEBAUTHN_ORIGINS`) before passkeys work in the Android app.

## Tasks, in order

T45 → T46 → T47 → T49 → T48 → T50 → T51. T45 and T46 can start at once. Each screen task waits for its API:

- **T47:** T19 (done) for claims; T40 and T41 for floats and company spending
- **T48:** T37 and T39 for paying bills and payroll
- **T49:** T21 (done)
- **T50:** T42
- **T51:** T22

**Notes**

- **T45:**
  - Copy `apps/admin`'s Next.js setup.
  - Employees who sign in see "Use the Expendi Business app".
  - The passkey files must be served as `application/json` with no redirect, from one source of truth, not two copies that can drift.
- **T46:**
  - Today an accountant is an email-only membership with no `users` row (T13). Migrate so an accountant invite creates or links a `users` row like any invite, and link existing accountant memberships by email on first sign-in.
  - Every write route must refuse `accountant`, proven by a test that lists every route, not by hiding buttons.
- **T47:** the batch approval API takes up to 20 claims per passkey confirmation; show the total and each claim's cost before confirming.
- **T48:** the browser is where admins upload invoice PDFs; the app only attaches images.
- **T49:**
  - Category editing is new: add, rename, archive and mark eTIMS-exempt, all audited.
  - The activity log is a company-scoped read for admins and accountants; the staff audit search stays staff-only.
- **Every task:** every new route gets an isolation-helper test and an accountant-refusal check where it acts.

## Environment variables

| Name                                                  | Where               | Purpose                                    |
| ----------------------------------------------------- | ------------------- | ------------------------------------------ |
| `DASHBOARD_ORIGINS`                                   | API (Doppler)       | Browser origins allowed on customer routes |
| `WEBAUTHN_ORIGINS` (+ `https://business.expendi.app`) | API (Doppler)       | Passkey approvals from the browser         |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`     | `apps/web` (Vercel) | API and Privy app                          |

## Exit criteria: Checkpoint D2

- Go-live checklist item 17 (spec §13) passes on staging
- The isolation helper covers every new route, and the accountant route-listing test passes
- Reviewed with Dennis

---

## QA checklist

**Automated**

- [ ] Every action route refuses an accountant (route-listing test)
- [ ] Browser requests from an origin that isn't the dashboard's are refused
- [ ] Isolation tests pass on every new route
- [ ] Category changes and approvals from the web are audited

**Admin, manual (desktop browser)**

- [ ] Sign in with an email code, then with a passkey
- [ ] Approve and pay 3 claims with one passkey, using the passkey on a phone through "use a phone or tablet"; each pays once
- [ ] Reject a claim with a reason; the employee sees it in the app
- [ ] Pay several due bills at once; adjust and pay a payroll run
- [ ] Withdraw to an allowlisted address
- [ ] Add, rename and archive a category; mark one eTIMS-exempt
- [ ] Invite an accountant

**Accountant, manual**

- [ ] Sign in; see expenses, bills, payroll runs with salaries, wallet history and activity
- [ ] No action is possible anywhere (and the API refuses it if forced)
- [ ] Download the monthly export, the receipts zip and the eTIMS report for a month
- [ ] Switch between two client companies; each shows only its own data

**Passkey domain**

- [ ] `https://business.expendi.app/.well-known/apple-app-site-association` and `/assetlinks.json` validate
- [ ] Passkeys work in the iOS and Android apps against that domain

**Hygiene**

- [ ] Build, typecheck and tests pass; no keys committed; no `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] Phase 3B issues are Done in Linear
- [ ] Checkpoint D2 reviewed with Dennis

---

## Handoff notes (fill in before ending each session)

- **Status (2026-11-02):** T45 and T46 code done (uncommitted at the time of writing). T47–T51 are next, each after its API (T42 for T50, T22 for T51).
- **Status (2026-11-02, fifth wave):** T47–T51 code done and included in the local release commit. All of Phase 3B is built; Checkpoint D2 hasn't run. The older web release is live at `business.expendi.app` on Vercel (Hobby, from a mirror repo; see Built). The fifth wave awaits the provider setup and deployment in `next-session.md`.
- **Built:**
  - **T47 expenses and approvals (EXP-318):**
    - **API:** `GET /organizations/:id/expenses` and `/:expenseId` (admins and accountants). Filters: `membershipId`, `kind` (`claim`, `petty_cash`, `company`), `categoryId`, `month`, `etimsStatus`, `cursor`, `limit` up to 100. A claim has no `float_id`; petty cash is float spending plus claims with a `float_id`; a bill paid outside appears once, as company spending. The detail returns receipts through presigned downloads.
    - **Web:** the expenses and approvals pages; batch approve with one passkey (`@simplewebauthn/browser` added); reject; retry.
    - **Shared helpers:** `lib/{money,dates,approval,use-approval,passkeys}.ts` and `components/{receipt-viewer,expense-status,approval-passkey-gate}.tsx`.
    - **Gaps:** stored passkey `transports` are stripped so an app passkey offers "use a phone or tablet"; the person filter lacks removed members; archived categories can't be picked in the filter; one detail request per queue card; `ApprovalPasskeyGate` still says to set up the passkey in the app (Settings can now do it).
  - **T48 bills, recurring, payees, payroll (EXP-319):**
    - Pages on the existing APIs, with no API changes. Desktop PDF invoice upload; Pay and Pay all (up to 20, with the 24-hour hold's second confirmation); payroll adjust and Approve & pay all; recurring pause, resume and end. Accountants are read-only, salaries included.
    - **Decisions:** the web shows full payee account numbers (Dennis approved on 2026-11-02; the app masks to the last 4). Unpaid USD bills show "≈ KES X today"; paid ones show USD only, because the bill read lacks the payment-day KES. Failed bills are retried one at a time.
  - **T49 wallet, team, settings, activity (EXP-320):**
    - **API:** `POST /organizations/:id/categories`, `PATCH …/categories/:categoryId` (rename, eTIMS-exempt), `POST …/:categoryId/archive` and `/restore` (admins; audited `category.created`, `updated`, `archived`, `restored`; 409 on a name clash or editing an archived one) and `GET …/categories?archived=true`. `GET /organizations/:id/activity` (admins and accountants; keyset paging; Nairobi dates).
    - **Migration:** `0061_company_activity_log`: the definer `company_activity_log(...)`, current company only, admin and accountant only, with no request ID, IP or device.
    - **Web:** wallet (withdraw and allowlist with a passkey, copy address, no QR), team, settings (categories, approval passkey set-up in the browser) and activity.
  - **T50 spending overview (EXP-321):** the overview page on T42's API. The shared display helpers moved to `packages/shared/src/overview.ts` (`heading` is now required), and the mobile app re-exports them. The API returns required `cash.outsideKes`; web and mobile show "Also due outside Expendi: KES X" when non-zero, using the shared `cashOutsideLine` helper (Dennis approved on 2026-11-02).
  - **T51 accountant downloads and eTIMS report (EXP-322):**
    - `GET /organizations/:id/reports/:month/:format` (`workbook`, `csv`, `receipts`, `etims`) now returns the file itself (attachment, `private, no-store`), built in a read-only transaction. Admins and accountants; employees get 403.
    - The eTIMS CSV has a BOM and the statuses "Attached", "Not required" and "None". It excludes rejected claims (Dennis approved on 2026-11-02; spec §6.14 updated). For an overspend whose extra claim was rejected, the float row still carries the whole purchase amount, matching the receipt.
    - The Reports page has a month picker and four downloads; admins can make shareable 30-day links.
    - **Gaps:** a future month isn't refused (it gives empty files); the web doesn't list stored exports.
  - **Vercel setup (done 2026-11-02):**
    - Project `expendi-business-web` (`prj_XuDDe4IkVsq9l4iKx9K6sGqtj2l8`) in the personal scope `dennohkims-projects` (Hobby). Root `apps/web`, Node 22.x, Next.js, "include files outside root" on. Env, all targets: `NEXT_PUBLIC_API_URL=https://api-dev-dcdc.up.railway.app` and `NEXT_PUBLIC_PRIVY_APP_ID`.
    - Deploys come from a private mirror, `github.com/DennohKim/expendi-business-web` (git remote `web-deploy`), a full copy of the monorepo.
    - **Release:** `git push origin main && git push web-deploy main`. Vercel deploys `main` of the mirror.
    - `business.expendi.app` was moved from a scratch project `business-page`. DNS is Cloudflare, CNAMEd to Vercel. The two passkey files serve `application/json` with no redirect.
  - **T45:**
    - **The app:** `apps/web` (Next.js 16, port 3002), copied from `apps/admin`.
    - **Sign-in:** an email code or a passkey, with a passkey offer after an email sign-in.
    - **After sign-in:**
      - several companies → a company picker
      - an employee → "Use the Expendi Business app"
      - no name yet → "Your full name" (`PATCH /me`)
      - otherwise → the dashboard shell, with placeholder pages naming their task
    - **Accountants** see a "View only" badge; `useDashboard().canAct` is admins only.
    - **Passkey files:** they now live only in `apps/web/public/.well-known/`, served as `application/json`.
    - **API:** CORS for `DASHBOARD_ORIGINS` on `/me/*` and `/organizations/*` only.
    - **Vercel:** `apps/web/vercel.json` builds through turbo.
  - **T46:**
    - **Accountants are now `users`** (migration 0049 backfills them; 0050 drops `memberships.email`/`full_name` and makes `user_id` NOT NULL).
    - **Invites:** an accountant invite is `invited` until first sign-in, and sends a dashboard email.
    - **No writes:** the tenant middleware refuses every non-GET request from an accountant on every company route.
    - **Reads:** `requireAdminOrReader()` opens every admin read to accountants.
    - **RLS (0051):** accountants can read bills, recurring items, payroll runs, payroll payouts and floats.
    - **Test:** a route-listing test proves every action refuses accountants, and every read matches the admin's.
- **Changes from spec or plan, and why:**
  - **Vercel Hobby and the mirror repo:** Hobby can't connect the private org repo `Expendi/Expendi-business`, and the `expendi` team (Pro) is suspended for a missing payment method. So Vercel deploys from a mirror. Before the pilot, move to a Pro team (reactivate `expendi` or upgrade): Hobby's terms don't allow commercial use.
  - **T49 (spec §6.14 updated):**
    - Category **restore** was added, which isn't in the spec's list. Reason: a mistaken archive shouldn't lose its Zoho mapping. Kept (Dennis, 2026-11-02); spec §6.14 lists it.
    - The activity page hides request ID, IP and device, and shows staff as "Expendi team" and systems as "Expendi (automatic)". Reason: customers shouldn't see staff identities or other people's network details.
    - Company details are read-only (no API for editing them), and the eTIMS-exempt flag isn't retroactive. Reason: the first needs a new API; the second keeps past claims' statuses unchanged.
- **Environment variables added:**
  - **API:** `DASHBOARD_ORIGINS` (optional, comma-separated).
  - **Web:** `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_PRIVY_CLIENT_ID` (optional).
  - **Vercel project:** root `apps/web`, Node 22, domain `business.expendi.app`. Set in the fifth wave (see Vercel setup above).
- **Known issues and TODOs:**
  - **Mobile copy:** done (T42): `roles.ts` now reads "View-only access at business.expendi.app, plus monthly exports by email."
  - **Export recipients:** done (T22): the export goes to every non-removed accountant, invited ones included.
  - **Vercel Hobby:** move to a Pro team before the pilot (see Changes above). The scratch project `business-page` can be deleted.
  - **R2 CORS:** the PDF invoice upload from the browser needs a bucket CORS rule (PUT and GET from `https://business.expendi.app` and `http://localhost:3002`, header `content-type`). Not set yet.
  - **Deploying migration 0050:** the old release reads the dropped columns, so expect a few seconds of errors while the new release replaces it.
- **QA results (2026-11-02, OpenCode):** 153 web, 272 mobile and 174 shared tests passed; web typecheck/lint/format and production build passed. The final eTIMS rejected-claim filter and web/mobile outside total are included. No real-browser or device QA was performed; Checkpoint D2 remains pending.
- **Next session starts with:** finish provider setup, deploy the API and web fifth wave, then run Checkpoint D2 against real uploads and passkeys.
