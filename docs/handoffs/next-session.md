# Next session: QA, setup and everything still pending

Written 2026-11-02 after the fifth build wave and setup steps 1–4. This one document is enough to start a new session; the phase handoffs hold the detail behind each item.

## Start prompt

> Read `docs/handoffs/README.md`, then `docs/handoffs/next-session.md`, then the Handoff notes in each phase handoff (`phase-1` to `phase-3b`). Tell me where things stand in five lines, then start with "Setup before any device QA" step 4's remaining R2 CORS and Resend DNS checks and go through the rest with me. Build the remaining tasks with parallel subagents, following "How to build in parallel" below.

---

## 1. Where things stand

**Shanga importer update (2026-11-02, local):** inspected all six TSVs and the XLSX (formulas and cached values); found templates/summary cells but no populated expense records. Ops now offers a Shanga expense layout with TSV support, conservative column suggestions, source-line previews, skipped template/summary rows, and paid/unpaid source-status validation. Money In is rejected; recurring/salary instructions require separately prepared files. No client records imported and no deployment performed for this update. Q2 history is outside the existing three-month window. See `docs/runbooks/shanga-import.md` for preparation requirements and remaining client decisions.

**Internal admin deployment update (2026-11-02):** release `c31bef2` is live at `https://expendi-admin.vercel.app` on the personal Vercel Hobby project `expendi-admin`, connected to `DennohKim/expendi-admin`. `expendibiz-admin.expendi.app` is attached but awaits its Cloudflare CNAME. API CORS for both URLs is configured and verified after restart; real staff login remains unverified. Railway reports API release `5454dee` as successfully deployed. See `docs/runbooks/internal-admin-deployment.md` for evidence, DNS and future release steps. This supersedes the older local-only admin/deployment notes below.

**Code:** every task from Phase 0 to Phase 3B now has an implementation, including T25's staff CSV importer (included in this release; migration 0065; deployment unverified). T28 has production build/submission and OTA commands plus release checks; actual store distribution and T29's live pilot remain pending. The last verified API and web deployment is `15978ee`, with migrations through 0064 applied on dev. Internal admin deployment and real-device/provider QA remain pending. See `docs/runbooks/pilot-release.md` for the importer and launch procedure.

**Local T25/T28 verification (2026-11-02):** API main 2,062 + serial 169 tests passed (main uses `--maxWorkers=2` on a dedicated local database); shared 181, mobile 272 and web 153 tests passed. API/admin/web builds and all workspace typechecks passed. API/mobile/shared lint/format and targeted import admin lint/format passed. Full-workspace lint/format reported errors in separately added admin/web dashboard/UI scaffolding; those concurrent changes were not modified by this task. Four release-config smoke checks and schema drift check passed. Client mapping review and live UI/device/provider QA are still required. Exact checks and the resolved flaky SMS fixture are recorded in `docs/work/remaining-tasks/task_plan.md`.

**Release follow-up (2026-11-02):** session `10863844-27a6-4b66-9ede-badb816e01ad` ended at its usage limit after both final builders finished. The eTIMS rejected-claim filter, web/mobile outside total, and T26 staff pages are present. Dennis subsequently populated R2, Resend and Telnyx credentials plus `ALERT_EMAILS`, and removed `ANTHROPIC_API_KEY` to keep AI receipt reading disabled. A read-only Doppler check confirmed those states without printing values. Commit `15978ee` was pushed to both `origin main` and `web-deploy main`. Credential presence does not validate provider behaviour.

Final combined verification (2026-11-02, OpenCode; real providers and device QA not exercised):

| Check                   | Count                                   |
| ----------------------- | --------------------------------------- |
| API, main suite         | 2,044 tests / 96 files                  |
| API, serial suite       | 169 tests / 15 files                    |
| Shared                  | 174 tests                               |
| Mobile                  | 272 tests                               |
| Web                     | 153 tests                               |
| Typecheck, lint, format | 20/20 tasks                             |
| Builds                  | API, admin, web                         |
| Migrations              | 0000–0064 from scratch, no schema drift |

- **2,812 tests passed in total.** All 20 typecheck/lint/format tasks and API/admin/web builds were run uncached. Frozen-lockfile validation passed. The dedicated local database was `expendi_business_test_release_20261102`; both API suites rebuild its schema from migrations. All 65 journal entries have SQL and snapshots, and the fifth-wave snapshot chain is valid.
- **Integration fix:** the first serial run found an order-dependent fixture in `internal-alerts.serial.test.ts`: cleanup aged only open webhook incidents, so a recently resolved incident from another file correctly outranked the test's older incident. A deterministic regression reproduced it; cleanup now ages all earlier webhook incidents. The 20-test file and all 169 serial tests pass; API typecheck and the changed test's lint/format were checked again. Production code did not need a change.
- **Released (2026-11-02):** `15978ee` pushed to both remotes. Railway dev API deployment `7d1c154e-b7c2-4e03-be4f-9521fb9acada` succeeded; logs confirm migrations and all station jobs started. A read-only database query confirmed 65 applied migrations with latest journal timestamp `1793621737780` (0064). `/health` returns HTTP 200 with `{"status":"ok"}`; dashboard CORS preflight returns 204 and allows `https://business.expendi.app`.
- **Web release:** Vercel deployment `dpl_3tj1sLhcxvPEwS2juRv9EJTH1YqQ` is Ready and aliased to `business.expendi.app`. Home, overview and reports returned 200; Apple/Android association files returned valid JSON with no redirects. These are HTTP smoke checks, not authenticated browser QA. The unrelated root `task_plan.md` and `notes.md` remain outside the commits.

**QA:** almost none has run on real devices. Dennis deferred it on 2026-11-02. The only live money tests so far are Checkpoint B's Phase 2 gate, which passed (see the Phase 1 handoff).

| Phase                       | Code                                             | QA                                          |
| --------------------------- | ------------------------------------------------ | ------------------------------------------- |
| 0 Foundation                | ✅                                               | ✅                                          |
| 1 Money path                | ✅                                               | Phase 2 gate ✅. **Phase 2B gate not run.** |
| 2 Claim flow (T11–T21, T32) | ✅                                               | **Checkpoint C not run**                    |
| 2B Spending (T34–T43)       | ✅                                               | **Checkpoint C2 not run**                   |
| 3 Internal tools            | ✅ (T25 local)                                   | **Checkpoint D not run**                    |
| 3B Web dashboard (T45–T51)  | ✅                                               | **Checkpoint D2 not run**                   |
| 4 Pilot launch              | T28 config/tooling ready; T29 operations pending | Store installs, OTA and go-live unverified  |

**Linear:**

- **Code done, waiting for QA (In Progress):**
  - Phase 2: EXP-279, 282, 286, 303, 289, 292, 293, 294, 295, 296, 298, 287
  - Phase 2B: EXP-305 to 314
  - Phase 3: EXP-280, 283, 290, 299, 301, 302, 315, and EXP-291 (T26: API and admin pages built; live QA pending)
  - Phase 3B: EXP-316 to 322
- **Status updates owed:** EXP-297 (T25) now implemented locally; EXP-284 (T28) release tooling prepared; EXP-300 (T29) still needs live execution. Linear was not updated in this session.
- **EXP-278 (T6)** should be Done; auto mode blocked Claude from setting it, twice. Dennis: set it by hand.

---

## 2. Where everything lives

| What                  | Value                                                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (dev)             | `https://api-dev-dcdc.up.railway.app`. Railway project `expendi-business`, environment `dev`, service `api`.                                                                                                                                                                                    |
| Deploys               | Fifth wave `15978ee` is deployed; migrations through 0064 verified on dev. API changes pushed to `main` deploy through Railway; docs-only changes are skipped by its watch patterns. The pre-deploy step is `pnpm --filter @expendi-business/api migrate`.                                      |
| Secrets               | Doppler `expendi-business` / `dev`. Railway holds only the Doppler token. Claude can't write secrets: Dennis sets them.                                                                                                                                                                         |
| Dev database          | No public address. Tunnel: `npx -y @railway/cli@5.71.0 connect Postgres -e dev --tunnel-only -P 55432`. If the port listens but connections are refused, kill whatever holds 55432 and reconnect.                                                                                               |
| Scripts against dev   | `doppler run -p expendi-business -c dev -- sh -c '…'`. Inside it, set `SECRETS_MANAGER=env` and rewrite `DATABASE_URL` / `DATABASE_URL_MIGRATE` to `localhost:55432`.                                                                                                                           |
| Test company (dev)    | "Expendi Test Co" `3881397e-cff4-4904-aa96-5fa0a8529a7d`, admin `hello@cradlelabs.io` (software passkey in `apps/api/.cache/checkpoint-b/`)                                                                                                                                                     |
| Test wallet           | `0x69685f698F002120af8185722A3C364A265BD0C3` on Base. **0.831325 USDC, nothing reserved.**                                                                                                                                                                                                      |
| Staff (dev)           | `hello@cradlelabs.io` as `ops_admin`, added 2026-11-02                                                                                                                                                                                                                                          |
| Mobile app            | EAS project `@chizaalabs/expendi-business` (`3c092318-4971-433e-b238-6b4586e09bac`), bundle ID and package `app.expendi.business`, Apple Team `46XB9S9YV6`.                                                                                                                                     |
| Dev build (Android)   | EAS build `8cc37fda-2ee4-4f90-9a68-32a2f2c637d3` (development profile, internal APK). EAS holds the keystore (remote credentials). Placeholder icons from the consumer app; real Expendi Business artwork is needed before T28.                                                                 |
| Android fingerprint   | SHA-256 `F1:64:51:AB:5B:D3:08:40:23:3E:A2:72:A9:4E:99:F3:E1:A5:DB:18:F1:EE:73:6E:F7:4B:94:67:9B:C5:74:37`. base64url (for `WEBAUTHN_ORIGINS`): `8WRRq1vTCEAjPqJyqU6Z8-Gl2xjx7nNu90uUZ5vFdDc`. It is in `assetlinks.json` (commit f890a3a, deployed).                                            |
| Privy                 | One app for every environment. Native client `client-WY6eucYDNEuaLXcZD1xccakbSZBYh1SU6kjnkkZRwgxbH`. Passkey relying party `business.expendi.app`.                                                                                                                                              |
| Web dashboard         | `apps/web`, live at `business.expendi.app`. It also serves the passkey files from `apps/web/public/.well-known/` (as `application/json`, no redirect).                                                                                                                                          |
| Vercel                | Project `expendi-business-web` (`prj_XuDDe4IkVsq9l4iKx9K6sGqtj2l8`) in the personal scope `dennohkims-projects` (Hobby). Root `apps/web`, Node 22.x, "include files outside root" on. Env, all targets: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`. DNS is Cloudflare, CNAMEd to Vercel. |
| Web deploy mirror     | Vercel deploys from a private mirror, `github.com/DennohKim/expendi-business-web` (git remote `web-deploy`), a full copy of the monorepo. Hobby can't connect the private org repo `Expendi/Expendi-business`.                                                                                  |
| Releasing the web app | `git push origin main && git push web-deploy main`. Vercel deploys `main` of the mirror.                                                                                                                                                                                                        |
| Internal admin        | `apps/admin` (port 3001). Not deployed.                                                                                                                                                                                                                                                         |
| Job lock keys         | 72_001 reconcile-paycrest, 72_002 confirm-onchain, 72_020/72_021 push, 72_022 monthly-export, 72_026 alert-checks, 72_031 zoho-sync, 72_035 bill-status, 72_036 recurring-bills, 72_038 payroll-drafts, 72_043 spending-reminders. Pick a new key outside this list.                            |
| Local test databases  | `expendi_business_test` (default), plus `_sync`, `_t14`, `_t16`, `_t21`, `_t23`, `_t32`, `_t34`, one per parallel builder                                                                                                                                                                       |

---

## 3. Setup before any device QA (Dennis, mostly dashboards)

Do these in order; each says what it unblocks.

1. **Vercel and DNS: done (2026-11-02).**
   - Project `expendi-business-web` with the env set; `business.expendi.app` moved over from a scratch project `business-page` (default Next.js page, can be deleted). `/.well-known/apple-app-site-association` and `assetlinks.json` serve `application/json` with no redirect.
   - The `expendi` Vercel team (Pro) is suspended for a missing payment method (`admin.expendi.app` returns 402), so the project lives on Hobby with the mirror repo (see "Where everything lives" and section 7).
2. **First Android dev build: done.** EAS build `8cc37fda-2ee4-4f90-9a68-32a2f2c637d3`. The first attempt (`db17b94c…`) failed in Gradle (`drawable/splashscreen_logo not found`) because `expo-splash-screen` had no image; fixed by adding placeholder `icon.png` and `icon-foreground.png` and setting `icon`, `android.adaptiveIcon` and the splash `image` in `app.config.ts` (commit f890a3a).
3. **Android signing fingerprint: done.** Read from the APK's v2 signature block (no JDK on the Mac; `eas credentials` is interactive only). Values are in "Where everything lives". Google's Digital Asset Links API returns it for `get_login_creds`.
4. **Doppler `dev` values: populated (2026-11-02); external setup and provider QA remain.**
   - **Real values set:** `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` (the web origin plus `android:apk-key-hash:<base64url>`), `DASHBOARD_ORIGINS`, `ADMIN_APP_ORIGINS`, `EMAIL_FROM=Expendi Business <team@expendi.app>`, `API_PUBLIC_URL=https://api-dev-dcdc.up.railway.app`, `APP_INSTALL_URL` (the EAS build page).
   - **Provider placeholders replaced by Dennis:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RESEND_API_KEY`, `TELNYX_API_KEY`, `TELNYX_VERIFY_PROFILE_ID`. A read-only check confirmed non-placeholder values without displaying secrets; this does not prove the providers work.
   - **AI receipt reading disabled by Dennis:** `ANTHROPIC_API_KEY` was removed. Manual entry remains available. Do not re-enable AI receipt reading without Dennis's request.
   - **Still to do outside Doppler:**
     - an R2 bucket CORS rule: PUT and GET from `https://business.expendi.app` and `http://localhost:3002`, header `content-type` (the web's invoice uploads need it)
     - SPF and DKIM for `expendi.app` (Resend) in Cloudflare
   - **New variables from this wave:**
     - `API_PUBLIC_URL` (T22): required for export links. Without it, generating answers 503 and the monthly job fails.
     - `ALERT_EMAILS` (T26): comma-separated; now set. Confirm delivery in Checkpoint D.
   - **Optional:** `EXPO_ACCESS_TOKEN` (only with enhanced push security).
5. **Privy dashboard:**
   - **Passkeys enabled and verified through Privy's public app config (2026-11-02).** This fixed the disabled-provider setting found during sign-in setup troubleshooting; successful device setup still needs confirmation.
   - native client allowed IDs `app.expendi.business` (iOS and Android) and scheme `expendi-business`
   - web origins `https://business.expendi.app`, `http://localhost:3001`, `http://localhost:3002`
   - the Android key hash from step 3
6. **Push credentials:**
   - **Android:** a Firebase project; upload `google-services.json` as the EAS file variable `GOOGLE_SERVICES_JSON`, and the FCM V1 key via `npx eas credentials`.
   - **iOS:** an APNs key via `eas credentials`.
   - Then rebuild the dev client (step 2).
7. **Top up the test wallet: about 25 USDC on Base.** (Steps 5–7 haven't started.) It covers the Phase 2B gate, Phase 2 claims, bills, a 3-person payroll and a small float. Use KES 65–100 amounts throughout. Paycrest's minimum is 0.5 USDC.

**Multi-person QA:** a development build needs Metro running. For several testers, build a `preview` APK (`--profile preview`); it uses the same keystore, so the fingerprint stays the same.

---

## 4. QA, in the order to run it

Every checklist below is the full list from its phase handoff, which has the detail. Record order IDs, tx hashes and M-Pesa results in that phase's Handoff notes as you go.

### 4.1 Checkpoint B, Phase 2B gate (live money; scripts are fine)

Needs step 7. Drive it with `apps/api/scripts/test-payout.ts` (see the Phase 1 runbook) or the app once it's on a phone.

- [ ] One real payment each to a **Till**, a **Paybill with an account number**, a **Kenyan bank account**, and an **allowlisted USDC address**. Each arrives with the right amount and reference.
- [ ] **Payroll cap:** a run over its cap is refused, and no Paycrest order is created.
- [ ] **Calibrate the fee buffer** (runbook step 11). `maxDebitFor` reserves 0.25 USDC + 0.5%, but the real Paycrest fee was 0.02 USDC. Decide the buffer.
- [ ] Record settlement times per channel. M-Pesa so far: paid in 35–70 s; a failed payout refunds about 31 minutes after funding.

### 4.2 Checkpoint C: Phase 2 on real phones

Needs steps 4–7 (1–3 are done). Full list in `phase-2-claim-flow.md`.

- **Admin:**
  - [ ] Create a company: a bad KRA PIN is rejected and a good one accepted; the deposit address and the USDC + KES balance show.
  - [ ] Invite an employee by email: the email arrives, they sign in, and their role is right.
  - [ ] Remove a member: they lose access immediately.
  - [ ] Approve & pay:
    - the preview shows KES, USDC, fee and total
    - the passkey prompt appears
    - M-Pesa receives the exact amount
    - the claim shows Paid
    - a push arrives
  - [ ] Reject without a reason is blocked. With a reason, the employee sees it, edits and resubmits.
  - [ ] Approving your own claim works and is flagged in the audit log.
  - [ ] Wallet:
    - history shows deposits, payouts and refunds; refunds now link to their payout
    - a non-allowlisted address can't be withdrawn to
    - withdrawing to an allowlisted address works after a passkey
- **Employee:**
  - [ ] Sign in with an email code; the name step appears the first time; set up a passkey; sign out; sign back in with the passkey.
  - [ ] Add the M-Pesa number: the Telnyx SMS code confirms it. Approve & pay is blocked before that.
  - [ ] A paper receipt photo pre-fills the fields (needs `ANTHROPIC_API_KEY`); the employee confirms and submits.
  - [ ] An M-Pesa screenshot pre-fills the fields.
  - [ ] A pasted SMS in each format parses, and random text falls back to manual entry. Real SMS samples are still needed for the fixtures.
  - [ ] Scanning a QR: a **TIMS** QR fills the invoice number. An **eTIMS** QR fills only the supplier PIN, since it carries no invoice number (spec §6.6). The company KRA PIN card shows.
  - [ ] The same M-Pesa code twice is blocked, and so is the same photo twice.
  - [ ] Same amount and date as another claim, or a date over 60 days ago: the admin sees a warning.
  - [ ] Employees see only their own claims.
- **Both roles:**
  - [ ] A user in two companies sees each separately.
  - [ ] A cheap Android phone on a slow network can upload.
  - [ ] iPhone, if any pilot staff use one.
  - [ ] All four pushes arrive: submitted, rejected, paid, failed.

### 4.3 Checkpoint C2: Phase 2B

Every item is now runnable (T42 and T43 are built). Full list in `phase-2b-spending-and-payments.md`.

- [ ] One payee per method. Change one payee's details: every admin is emailed, and paying within 24 hours asks for a second confirmation.
- [ ] A monthly subscription paid through Expendi, due in 2 days: the reminder arrives (T43), pay it, and next month's bill appears.
- [ ] A **USD bill** to a USDC payee pays the exact USDC.
- [ ] A card-only subscription set up as paid outside: the reminder arrives, and marking it paid creates one company spending record.
- [ ] A variable bill (PAYE to KRA's Paybill): enter the amount and reference, then pay.
- [ ] Payroll with 3 numbers:
  - adjust one person's pay with a reason
  - Approve & pay all
  - force one failure; only that person is retried
- [ ] Change a salary and the payroll margin: each needs a passkey, and every admin is emailed.
- [ ] As an employee: you see only your own salary payments, through the app and through the API.
- [ ] A float (use KES 200):
  - two purchases, and the balance is right
  - overspending creates a claim for exactly the extra
  - close it; with money left, closing needs a write-off reason
- [ ] The overview matches a hand calculation (T42), and the cash check shows Short when the wallet is low. A bill paid outside Expendi is listed but doesn't count against the wallet.
- [ ] Overspend (T40 fixes): an overspend claim with an SMS receipt submits, an amount edit is refused (409), and the claim view shows `floatId`.
- [ ] Notifications (T43), from 08:00 Nairobi for the daily ones:
  - bill due soon, due today and overdue: admins get push and email, once per bill and stage
  - wallet short for the next 7 days: admins get push and email, at most once per Nairobi day
  - payroll ready to review: admins get a push
  - salary paid: only that employee gets a push, with no amount
  - float issued or topped up: the holder gets a push

### 4.4 Checkpoint D: Phase 3

Needs the Zoho setup (section 6) and `ALERT_EMAILS`. T25's local code must be deployed before client import QA. Full list in `phase-3-accountant-and-internal-tools.md`.

- [ ] Admin app:
  - a non-staff email can't sign in
  - a viewer can look but not act (also via the API)
  - Dennis's account works (`ops_admin` on dev)
- [ ] Payout queue:
  - a `needs_review` payout shows; re-fetch works
  - resolving needs a reason and a second confirmation, and is audited
  - try it once on dev, because the on-chain log search may hit Alchemy's block-range limit
- [ ] Pause all, pause one company, and unpause.
- [ ] The audit log viewer finds staff actions and allows no edits.
- [ ] Export a month (T22), needs `API_PUBLIC_URL` and a real R2 bucket:
  - the workbook opens in Excel and Sheets; float issues and top-ups are on the third sheet "Float transfers"
  - the CSV download is a zip of three CSVs
  - amounts, the self-approved column (filled only for claims) and receipt names match the zip
  - the admin app's export screen gives three 30-day links
  - the monthly email arrives from `expendi.app`, one per non-removed accountant (invited included), each with their own link; removing the accountant stops theirs
- [ ] **T25 built locally; client QA pending:** import the pilot's sample spreadsheet: dry run → import → a re-run imports nothing → an imported M-Pesa code blocks a duplicate. The public UKEF fixture has passed this flow locally with test-only KES values.
- [ ] Trigger each of the 6 alerts once (T26), with `ALERT_EMAILS` set:
  - one email each, and resolving clears it
  - the first run after deploy emails existing `needs_review` and recently failed payouts once
  - check the Alerts and System health pages as both `ops_viewer` and `ops_admin`; non-staff must be refused
  - confirm the reconciliation heartbeat and latest webhook incident; only `reconcile-paycrest` currently records a heartbeat
- [ ] Zoho Books, against a test org in KES:
  - connect via the emailed link; a used link is refused; a non-KES org is refused
  - map categories
  - pay a claim and check it in Zoho (T31)
  - revoke access → `needs_reconnect` + alert; reconnect → the backlog syncs
  - force a failed sync: it shows under "Syncs to Zoho" in the admin app, and requeueing it works (T31)
  - pay a bill, record petty cash and company spending, and pay a payroll run (T44)
  - confirm Zoho accepts the Paid Through account types; Zoho's docs don't list them
  - confirm against live Zoho the things the code assumes: the exact-match `reference_number` filter, the amount as a JSON number, "add receipt" when one exists, size limits and the daily call limit (1,000/day free; 2–4 calls per claim)
  - confirm PDF receipts attach (T44), and with the accountant whether payroll posts on the pay date or the paid date

### 4.5 Checkpoint D2: web dashboard

Needs step 4 (real values) and the R2 CORS rule. Full list in `phase-3b-web-dashboard.md`.

- [ ] Sign in at `business.expendi.app` with an email code, then with a passkey.
- [ ] Approve 3 claims with one passkey from a desktop browser, using the phone through "use a phone or tablet"; each pays once.
- [ ] Pay several bills at once; adjust and pay a payroll run; withdraw.
- [ ] Upload a PDF invoice to a bill from a desktop browser (needs the R2 CORS rule).
- [ ] Set up the approval passkey in the browser (Settings), then approve with it.
- [ ] Edit categories (add, rename, archive, restore, eTIMS-exempt).
- [ ] The activity page shows the company's entries, with no request ID, IP or device.
- [ ] Accountant:
  - sees everything, salaries included
  - can't act (the API refuses it too)
  - downloads the export, the receipts zip and the eTIMS report from the Reports page (month picker, four downloads)
  - switches between two companies
- [ ] The passkey files validate (Apple and Google checkers), and passkeys work in both apps.

### 4.6 Go-live (Phase 4)

T28 (production builds, TestFlight and Play testing, a week before go-live), then the spec §13 checklist (items 1–18) with the pilot company. See `phase-4-pilot-launch.md`.

---

## 5. Code still to build

T25 is implemented locally using configurable CSV mapping and a public expense fixture. T28's configuration/tooling is prepared; its store/device acceptance criteria and T29 are operational work. T26's API and admin pages await live QA.

| Wave     | Task                         | Linear  | Depends on                                                                        |
| -------- | ---------------------------- | ------- | --------------------------------------------------------------------------------- |
| Local    | T25 Spreadsheet import       | EXP-297 | Deploy migration 0065/API/admin; verify the client's actual sample and mapping.   |
| Prepared | T28 Getting the app to staff | EXP-284 | Real artwork, target platforms, production env/push credentials and store access. |
| Last     | T29 Pilot go-live            | EXP-300 | everything                                                                        |

**Small fixes still open, which can ride along with any wave:**

- **Funding tx hash:** not saved on payouts. Paycrest's order has it, so sync could fill it in.
- **Large bills:** a non-payroll bill above Paycrest's ~3,000 USDC per order isn't split.
- **Railway config:** `railway.json` (Config as Code) stops working 2026-12-01. Move to Infrastructure as Code, or to dashboard settings.
- **Withdrawals:** allowlist changes and withdrawals don't email the other admins.

---

## 6. Inputs only Dennis can give

| Input                                                                                                                                                                                                                                                                                                                                                                         | Unblocks                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Setup step 4's remaining R2 CORS and Resend DNS checks, and steps 5–7 above                                                                                                                                                                                                                                                                                                   | All device QA; provider credentials are populated                                                |
| Deferred by Dennis: about 50 redacted, labelled receipts plus `ANTHROPIC_API_KEY`, only if AI receipt reading is enabled later                                                                                                                                                                                                                                                | T16 model eval (`apps/api/scripts/eval-receipts.ts`); not required while the feature is disabled |
| Real M-Pesa SMS, one per format (Buy Goods, Send Money, Paybill)                                                                                                                                                                                                                                                                                                              | Real fixtures for T15 (today's are synthetic)                                                    |
| The pilot spreadsheet: headers and 3 sample rows per part                                                                                                                                                                                                                                                                                                                     | T25 import                                                                                       |
| Zoho: a server-based client in api-console.zoho.com (redirect `<api>/integrations/zoho/callback`, Multi-DC on, same credentials for all data centres); `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI` and `ACCOUNTING_TOKEN_KEY` (`openssl rand -base64 32`, never changed afterwards) in Doppler; a test Books org in KES with an "Expendi Wallet" bank account | T30 QA, T31, T44                                                                                 |
| The accountant: Zoho expense accounts, the Paid Through account, how to post salaries, eTIMS gross posting                                                                                                                                                                                                                                                                    | T31/T44 mapping, go-live                                                                         |
| `ALERT_EMAILS` is set; verify a test alert reaches its recipients                                                                                                                                                                                                                                                                                                             | T26 live delivery QA                                                                             |
| The pilot's recurring items, card-only subscriptions and statutory Paybills                                                                                                                                                                                                                                                                                                   | Checkpoint C2                                                                                    |
| Real Expendi Business app artwork (icon, adaptive icon, splash)                                                                                                                                                                                                                                                                                                               | T28                                                                                              |
| Apple Developer + App Store Connect, Google Play Console; which phones staff use                                                                                                                                                                                                                                                                                              | T28                                                                                              |

---

## 7. Known issues and open decisions

- **Decisions Dennis made (2026-11-02):**
  1. **Payee account numbers on the web (T48):** keep full numbers on the web. The app still masks to the last 4.
  2. **T43 channels:** follow spec §6.10. Push and email only for due-date reminders, low balance and payee changes; push only for payroll-ready, salary-paid and float notices.
  3. **Overview cash check:** show the total due outside Expendi ("Also due outside Expendi: KES X"). The API now returns `outsideKes`; spec §6.24 updated.
  4. **eTIMS report (T51):** rejected claims are left out. Spec §6.14 updated.
  5. **Export float transfers (T22):** keep the third sheet "Float transfers". Spec §6.11 updated.
  6. **Overspend claims in Zoho (T44):** post through the Expendi wallet account. Spec §6.17 updated; confirm with the accountant at Zoho QA.
  7. **Category restore (T49):** keep it. Spec §6.14 already lists it.
- **Hosting:**
  - The web app runs on Vercel Hobby, whose terms don't allow commercial use. Before the pilot, move to a Pro team: reactivate the suspended `expendi` team (missing payment method; `admin.expendi.app` returns 402 because of it) or upgrade. Then reconnect the org repo and drop the `web-deploy` mirror.
  - The scratch Vercel project `business-page` can be deleted.
- **Fifth wave deployed:** migrations 0055–0064 and API/web code shipped in `15978ee`. Migration `0057_salty_bloodstrike` was renamed `0057_accounting_sync_columns` before deployment. `0064_staff_ops_alerts_reads` adds the company-name lookup for the staff alert list without granting customer access. The internal admin app is still local-only.
- **Another session's leftovers:** around 13:11–13:27 on 2026-11-02 an unidentified session left drafts for T42/T50, T43, T22/T51, T31/T44 and T47 (migrations 0055–0058) and untracked `task_plan.md` and `notes.md` at the repo root. This session's builders took the drafts over and reworked them. `task_plan.md` and `notes.md` aren't ours: leave them out of commits.
- **Gaps by task (fifth wave):**
  - **T42/T50:** fees and whole-shilling round-up aren't predicted in the cash check; bills paid outside are listed but not counted against the wallet; a variable bill without an amount shows `unknownAmounts` instead of making the check "unknown".
  - **T43:** no payout-failed notifications for bills or floats (only claims); the app's notification tap only opens claims; payroll bills get no per-person due reminders.
  - **T22:** a receipt missing from R2 fails the whole export (503); if recording a sent email fails, the next run re-sends with a new link; the receipts zip is built in memory (fine at pilot scale).
  - **T31/T44:** only companies with a connection that isn't disconnected queue syncs (no history push on first connect); JPEG, PNG, GIF, BMP and PDF receipts attach (WebP and HEIC post without one; PDF support still needs live confirmation); a sync is tied to the Zoho org of its first try; missing mappings defer with a message; zero-total payroll runs aren't queued.
  - **T26:** only Paycrest signature failures alert; staff-resolved failed payouts also email; the Zoho alert shows counts, not error text; low-balance shows only the spendable balance; if the whole API is down nothing alerts (needs external uptime monitoring). The admin alerts and health pages are built; only `reconcile-paycrest` records a heartbeat. The admin app has no component-test setup; staff routes have 20 serial tests.
  - **T47:** stored passkey `transports` are stripped so an app passkey offers "use a phone or tablet"; the person filter lacks removed members; archived categories can't be picked in the filter; one detail request per queue card; `ApprovalPasskeyGate` still says to set up the passkey in the app (Settings can now do it).
  - **T48:** unpaid USD bills show "≈ KES X today" (the bill read lacks the payment-day KES); failed bills are retried one at a time.
  - **T49:** company details are read-only (no API); the eTIMS-exempt flag isn't retroactive; the wallet page has no QR.
  - **T51:** a future month isn't refused (it gives empty files); the web doesn't list stored exports.
- **Not yet proven live:**
  - R2 uploads
  - Telnyx codes
  - Resend email
  - Expo push
  - the Privy passkey and `latest_verified_at` behaviour that approval-passkey enrolment relies on (if Privy doesn't update it, enrolment fails closed with "sign in again")
  - Zoho (including the assumptions listed under Checkpoint D)
  - the web dashboard's browser uploads and passkeys
- **Refunds:** Paycrest refunds come from its Gateway and are now linked to their payout. A few corner cases still land as plain deposits; the balance is always right.
- **Paycrest quirks:**
  - It returns 404 for a refunding order for about 30 minutes. Reconcile only flags a payout for review after its threshold: funding 10 minutes, paying 2 hours.
  - No M-Pesa receipt number comes back (`paymentReference` is null).
- **Staff resolve (T24)** depends on Alchemy's log search. If the plan limits block ranges, it refuses with a 503 and changes nothing.
- **Payee responses:** the payee list and detail return full account numbers to admins; only the app masks them. Kept on the web too (decision 1).
- **"Sign in again"** for passkey enrolment is a full sign-out.
- **T16 / T18 gaps:** a receipt read that finishes after submit isn't copied to the claim; near-duplicate warnings go on the newer claim only.
- **Payroll gaps:**
  - payroll payout USDC amounts are visible in `wallet_transactions` to any company scope (no employee route reads them)
  - ending a salary and re-creating it for the same pay day can draft a person twice
- **Overspend (T40):** the earlier gaps are fixed (SMS receipt compared with the whole purchase, amount edits refused with 409, `floatId` on the claim view, near-duplicate check skips the paired float row).
- **Deploying migration 0050** drops two membership columns; expect a few seconds of errors from the old release during that deploy.

---

## 8. How to build in parallel (what worked in these sessions)

- **About 5 builders at once.** Seven at once hit the 5-hour usage limit; agents then resume with a message once it resets.
- **Every builder brief includes:**
  - its own test database (`TEST_DATABASE_URL` / `TEST_DATABASE_URL_MIGRATE` prefix)
  - the migration lock (`mkdir apps/api/drizzle/.migration-lock`; edit schema + generate + prettier + "No schema changes" in one go; `rmdir`)
  - the install lock (`mkdir .install-lock`)
  - re-reading shared files right before editing them
  - no commits, no `docs/` edits, no Railway/Doppler, no real providers
  - mutation checks on the key guards
- **Before starting, check for another session's drafts** (untracked files, migration numbers already in `drizzle/`). Builders can take them over, as this wave did.
- **Expect transient load failures:** a test run that starts while another builder is writing a migration fails to load. Re-run before concluding anything.
- **Two builders must not change the same hook or service in parallel.** T37 and T39 shared the bill payout hook, so one builder did both.
- **The main session** verifies each report by re-running its tests, runs the integration pass (`pnpm turbo run typecheck lint format`, the API main + serial suites on a fresh database, `db:generate` for drift, shared and mobile tests, builds), updates the docs, then asks Dennis before committing.
- **Guard tests to keep green:**
  - `internal-routes.test.ts`: no staff route can reach payout-creating code
  - `accountant-access.test.ts`: accountants can't change anything
  - `payout-sync.serial.test.ts`
