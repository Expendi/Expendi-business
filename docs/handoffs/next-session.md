# Next session: QA, setup and everything still pending

Written 2026-11-02 after the fourth build wave. This one document is enough to start a new session; the phase handoffs hold the detail behind each item.

## Start prompt

> Read `docs/handoffs/README.md`, then `docs/handoffs/next-session.md`, then the Handoff notes in each phase handoff (`phase-1` to `phase-3b`). Tell me where things stand in five lines, then start with "Setup before any device QA" step 1 and go through it with me. Build the remaining tasks with parallel subagents, following "How to build in parallel" below.

---

## 1. Where things stand

**Code:** every task from Phase 0 to Phase 2B is built except T42 and T43. Phase 3 has T23, T24, T27 and T30. Phase 3B has T45 and T46. All of it passes:

| Check                   | Count                                   |
| ----------------------- | --------------------------------------- |
| API, main suite         | 1,853 tests                             |
| API, serial suite       | 110 tests                               |
| Shared                  | 174 tests                               |
| Mobile                  | 260 tests                               |
| Typecheck, lint, format | 20/20 tasks                             |
| Builds                  | API, admin, web                         |
| Migrations              | 0000–0054 from scratch, no schema drift |

**QA:** almost none has run on real devices. Dennis deferred it on 2026-11-02. The only live money tests so far are Checkpoint B's Phase 2 gate, which passed (see the Phase 1 handoff).

| Phase                       | Code               | QA                                          |
| --------------------------- | ------------------ | ------------------------------------------- |
| 0 Foundation                | ✅                 | ✅                                          |
| 1 Money path                | ✅                 | Phase 2 gate ✅. **Phase 2B gate not run.** |
| 2 Claim flow (T11–T21, T32) | ✅                 | **Checkpoint C not run**                    |
| 2B Spending (T34–T41)       | ✅ except T42, T43 | **Checkpoint C2 not run**                   |
| 3 Internal tools            | T23, T24, T27, T30 | **Checkpoint D not run**                    |
| 3B Web dashboard            | T45, T46           | **Checkpoint D2 not run**                   |
| 4 Pilot launch              | not started        | —                                           |

**Linear:**

- **Code done, waiting for QA (In Progress):**
  - Phase 2: EXP-279, 282, 286, 303, 289, 292, 293, 294, 295, 296, 298, 287
  - Phase 2B: EXP-305 to 312
  - Phase 3: EXP-280, 283, 290, 301
  - Phase 3B: EXP-316, 317
- **Not started (Backlog):**
  - Phase 2B: EXP-313 (T43), 314 (T42)
  - Phase 3: EXP-299 (T22), 297 (T25), 291 (T26), 302 (T31), 315 (T44)
  - Phase 3B: EXP-318 to 322 (T47–T51)
  - Phase 4: EXP-284 (T28), 300 (T29)
- **EXP-278 (T6)** should be Done; auto mode blocked Claude from setting it.

---

## 2. Where everything lives

| What                 | Value                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (dev)            | `https://api-dev-dcdc.up.railway.app`. Railway project `expendi-business`, environment `dev`, service `api`.                                                                                      |
| Deploys              | Every push to `main` deploys. The pre-deploy step `pnpm --filter @expendi-business/api migrate` is set in the dashboard, and deploy logs show `[migrate] migrations applied`.                     |
| Secrets              | Doppler `expendi-business` / `dev`. Railway holds only the Doppler token. Claude can't write secrets: Dennis sets them.                                                                           |
| Dev database         | No public address. Tunnel: `npx -y @railway/cli@5.71.0 connect Postgres -e dev --tunnel-only -P 55432`. If the port listens but connections are refused, kill whatever holds 55432 and reconnect. |
| Scripts against dev  | `doppler run -p expendi-business -c dev -- sh -c '…'`. Inside it, set `SECRETS_MANAGER=env` and rewrite `DATABASE_URL` / `DATABASE_URL_MIGRATE` to `localhost:55432`.                             |
| Test company (dev)   | "Expendi Test Co" `3881397e-cff4-4904-aa96-5fa0a8529a7d`, admin `hello@cradlelabs.io` (software passkey in `apps/api/.cache/checkpoint-b/`)                                                       |
| Test wallet          | `0x69685f698F002120af8185722A3C364A265BD0C3` on Base. **0.831325 USDC, nothing reserved.**                                                                                                        |
| Staff (dev)          | `hello@cradlelabs.io` as `ops_admin`, added 2026-11-02                                                                                                                                            |
| Mobile app           | EAS project `@chizaalabs/expendi-business` (`3c092318-4971-433e-b238-6b4586e09bac`), bundle ID and package `app.expendi.business`, Apple Team `46XB9S9YV6`. **No build exists yet.**              |
| Privy                | One app for every environment. Native client `client-WY6eucYDNEuaLXcZD1xccakbSZBYh1SU6kjnkkZRwgxbH`. Passkey relying party `business.expendi.app`.                                                |
| Web dashboard        | `apps/web`, to be on Vercel at `business.expendi.app`. It also serves the passkey files from `apps/web/public/.well-known/`.                                                                      |
| Internal admin       | `apps/admin` (port 3001). Not deployed.                                                                                                                                                           |
| Local test databases | `expendi_business_test` (default), plus `_sync`, `_t14`, `_t16`, `_t21`, `_t23`, `_t32`, `_t34`, one per parallel builder                                                                         |

---

## 3. Setup before any device QA (Dennis, mostly dashboards)

Do these in order; each says what it unblocks.

1. **Vercel and DNS.**
   - Create a Vercel project from this repo: root `apps/web`, Node 22, keep "include files outside the root".
   - Env: `NEXT_PUBLIC_API_URL=https://api-dev-dcdc.up.railway.app` and `NEXT_PUBLIC_PRIVY_APP_ID` (the same as Doppler's `PRIVY_APP_ID`).
   - Point `business.expendi.app` at it.
   - **Unblocks:** passkey files, the web dashboard.
2. **First Android dev build:** `cd apps/mobile && npx eas build --profile development --platform android`. Let EAS create the keystore. It needs `expo-camera`, `expo-notifications`, `react-native-passkeys` and `react-native-svg`, so the old plan of no build is moot. **Unblocks:** everything on a phone.
3. **Android signing fingerprint.**
   - Get it from `npx eas credentials -p android` (SHA-256).
   - Replace `<SHA256_CERT_FINGERPRINT>` in `apps/web/public/.well-known/assetlinks.json` (colon form), then commit and redeploy the web app.
   - For `WEBAUTHN_ORIGINS`, convert it to base64url: `echo "AA:BB:…" | tr -d ':' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='`.
   - **Unblocks:** passkeys in the Android app.
4. **Doppler `dev` values:**
   - **Passkeys:** `WEBAUTHN_RP_ID=business.expendi.app` and `WEBAUTHN_ORIGINS=https://business.expendi.app,android:apk-key-hash:<base64url from step 3>`
   - **Browser origins:** `DASHBOARD_ORIGINS=https://business.expendi.app,http://localhost:3002` and `ADMIN_APP_ORIGINS=http://localhost:3001` (plus the admin app's URL once deployed)
   - **Receipts:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, for a private bucket. R2 uploads have never run against a real bucket.
   - **Email:** `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Expendi Business <team@expendi.app>`), `APP_INSTALL_URL`. Also SPF and DKIM for `expendi.app` in DNS.
   - **Payout phone codes:** `TELNYX_API_KEY` and `TELNYX_VERIFY_PROFILE_ID`, from a new Verify profile on the consumer's Telnyx account.
   - **Optional now:**
     - `ANTHROPIC_API_KEY` (receipt reading; without it every read is "couldn't read")
     - `EXPO_ACCESS_TOKEN` (only with enhanced push security)
5. **Privy dashboard:**
   - passkeys on
   - native client allowed IDs `app.expendi.business` (iOS and Android) and scheme `expendi-business`
   - web origins `https://business.expendi.app`, `http://localhost:3001`, `http://localhost:3002`
   - the Android key hash from step 3
6. **Push credentials:**
   - **Android:** a Firebase project; upload `google-services.json` as the EAS file variable `GOOGLE_SERVICES_JSON`, and the FCM V1 key via `npx eas credentials`.
   - **iOS:** an APNs key via `eas credentials`.
   - Then rebuild the dev client (step 2).
7. **Top up the test wallet: about 25 USDC on Base.** It covers the Phase 2B gate, Phase 2 claims, bills, a 3-person payroll and a small float. Use KES 65–100 amounts throughout. Paycrest's minimum is 0.5 USDC.

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

Needs steps 1–7. Full list in `phase-2-claim-flow.md`.

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

Needs T42 and T43 built first for the overview and reminder items; the rest can run now. Full list in `phase-2b-spending-and-payments.md`.

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
- [ ] The overview matches a hand calculation (T42), and the cash check shows Short when the wallet is low.
- [ ] Every new notification arrives, by push and email (T43).

### 4.4 Checkpoint D: Phase 3

Needs T22, T25, T26, T31 and T44 built, plus Zoho setup. Full list in `phase-3-accountant-and-internal-tools.md`.

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
- [ ] Export a month (T22): it opens in Excel and Sheets; amounts, the self-approved column and receipt names match the zip; the email arrives from `expendi.app`.
- [ ] Import the pilot's sample spreadsheet (T25): dry run → import → a re-run imports nothing → an imported M-Pesa code blocks a duplicate.
- [ ] Trigger each of the 6 alerts once (T26).
- [ ] Zoho Books, against a test org in KES:
  - connect via the emailed link; a used link is refused; a non-KES org is refused
  - map categories
  - pay a claim and check it in Zoho (T31)
  - revoke access → `needs_reconnect` + alert; reconnect → the backlog syncs
  - pay a bill, record petty cash and company spending, and pay a payroll run (T44)
  - confirm Zoho accepts the Paid Through account types; Zoho's docs don't list them

### 4.5 Checkpoint D2: web dashboard

Needs T47–T51 built and step 1. Full list in `phase-3b-web-dashboard.md`.

- [ ] Sign in at `business.expendi.app` with an email code, then with a passkey.
- [ ] Approve 3 claims with one passkey from a desktop browser, using the phone through "use a phone or tablet"; each pays once.
- [ ] Pay several bills at once; adjust and pay a payroll run; withdraw.
- [ ] Edit categories (add, rename, archive, eTIMS-exempt).
- [ ] Accountant:
  - sees everything, salaries included
  - can't act (the API refuses it too)
  - downloads the export, the receipts zip and the eTIMS report
  - switches between two companies
- [ ] The passkey files validate (Apple and Google checkers), and passkeys work in both apps.

### 4.6 Go-live (Phase 4)

T28 (production builds, TestFlight and Play testing, a week before go-live), then the spec §13 checklist (items 1–18) with the pilot company. See `phase-4-pilot-launch.md`.

---

## 5. Code still to build

Run these as parallel subagents, as the last four waves did. "Ready now" means everything they depend on is built.

| Wave      | Task                                             | Linear  | Depends on (all built unless noted)                           |
| --------- | ------------------------------------------------ | ------- | ------------------------------------------------------------- |
| Ready now | T42 Spending overview                            | EXP-314 | 19, 37, 39, 40, 41                                            |
| Ready now | T43 Reminders and spending notifications         | EXP-313 | 20, 34, 36, 38, 40. Use `notify(tx, event)`.                  |
| Ready now | T22 Monthly export                               | EXP-299 | 19, 37, 39, 40, 41                                            |
| Ready now | T31 Push paid claims to Zoho                     | EXP-302 | 9, 19, 30                                                     |
| Ready now | T25 Spreadsheet import                           | EXP-297 | 18, 23, 34, 36, 38, 40. Needs the pilot's spreadsheet sample. |
| Ready now | T47 Expenses and approvals on the web            | EXP-318 | 19, 45                                                        |
| Ready now | T48 Bills, recurring, payees, payroll on the web | EXP-319 | 34–39, 45                                                     |
| Ready now | T49 Wallet, team, settings, activity on the web  | EXP-320 | 12, 13, 21, 45, 46                                            |
| Next      | T26 Alerts                                       | EXP-291 | needs T31                                                     |
| Next      | T44 Push other paid spending to Zoho             | EXP-315 | needs T31                                                     |
| Next      | T50 Spending overview on the web                 | EXP-321 | needs T42                                                     |
| Next      | T51 Accountant downloads and the eTIMS report    | EXP-322 | needs T22                                                     |
| Last      | T28 Getting the app to staff                     | EXP-284 | none (start a week before go-live)                            |
| Last      | T29 Pilot go-live                                | EXP-300 | everything                                                    |

**Small fixes, which can ride along with any wave:**

- **Overspend claims (T40):**
  - editing one with an SMS receipt fails, because the SMS amount is compared to the extra
  - amount edits aren't blocked
  - the claim view doesn't show `floatId`
  - the paired float row may be flagged as a near-duplicate
- **Mobile accountant copy:** `apps/mobile/src/features/company/roles.ts` still says accountants have "No app login". Point them at the dashboard.
- **T22 export recipients:** send to accountants whose membership isn't removed, since invited ones may not have signed in yet.
- **Large bills:** a non-payroll bill above Paycrest's ~3,000 USDC per order isn't split.
- **Funding tx hash:** not saved on payouts. Paycrest's order has it, so sync could fill it in.
- **Railway config:** move off `railway.json` (Config as Code stops working 2026-12-01) to Infrastructure as Code, or to dashboard settings.

---

## 6. Inputs only Dennis can give

| Input                                                                                                                                                                                                                                                                                                                                                                         | Unblocks                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup steps 1–7 above                                                                                                                                                                                                                                                                                                                                                         | All device QA                                                                                                                                             |
| About 50 redacted, labelled receipts plus `ANTHROPIC_API_KEY`                                                                                                                                                                                                                                                                                                                 | The T16 model eval (`apps/api/scripts/eval-receipts.ts`). The default is Opus 5.5 at ~$0.024 per receipt; Haiku 5.5 would be ~$0.0006 if accurate enough. |
| Real M-Pesa SMS, one per format (Buy Goods, Send Money, Paybill)                                                                                                                                                                                                                                                                                                              | Real fixtures for T15 (today's are synthetic)                                                                                                             |
| The pilot spreadsheet: headers and 3 sample rows per part                                                                                                                                                                                                                                                                                                                     | T25 import                                                                                                                                                |
| Zoho: a server-based client in api-console.zoho.com (redirect `<api>/integrations/zoho/callback`, Multi-DC on, same credentials for all data centres); `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI` and `ACCOUNTING_TOKEN_KEY` (`openssl rand -base64 32`, never changed afterwards) in Doppler; a test Books org in KES with an "Expendi Wallet" bank account | T30 QA, T31, T44                                                                                                                                          |
| The accountant: Zoho expense accounts, the Paid Through account, how to post salaries, eTIMS gross posting                                                                                                                                                                                                                                                                    | T31/T44 mapping, go-live                                                                                                                                  |
| The alert email list                                                                                                                                                                                                                                                                                                                                                          | T26                                                                                                                                                       |
| The pilot's recurring items, card-only subscriptions and statutory Paybills                                                                                                                                                                                                                                                                                                   | Checkpoint C2                                                                                                                                             |
| Apple Developer + App Store Connect, Google Play Console; which phones staff use                                                                                                                                                                                                                                                                                              | T28                                                                                                                                                       |

---

## 7. Known issues and open decisions

- **Not yet proven live:**
  - R2 uploads
  - Telnyx codes
  - Resend email
  - Expo push
  - the Privy passkey and `latest_verified_at` behaviour that approval-passkey enrolment relies on (if Privy doesn't update it, enrolment fails closed with "sign in again")
  - Zoho
  - the web dashboard
- **Refunds:** Paycrest refunds come from its Gateway and are now linked to their payout. A few corner cases still land as plain deposits; the balance is always right.
- **Paycrest quirks:**
  - It returns 404 for a refunding order for about 30 minutes. Reconcile only flags a payout for review after its threshold: funding 10 minutes, paying 2 hours.
  - No M-Pesa receipt number comes back (`paymentReference` is null).
- **Staff resolve (T24)** depends on Alchemy's log search. If the plan limits block ranges, it refuses with a 503 and changes nothing.
- **Payee responses:** the payee list and detail return full account numbers to admins; only the app masks them. Accepted for now.
- **Withdrawals:** allowlist changes and withdrawals don't email the other admins (payee changes do).
- **"Sign in again"** for passkey enrolment is a full sign-out.
- **T16 / T18 gaps:** a receipt read that finishes after submit isn't copied to the claim; near-duplicate warnings go on the newer claim only.
- **Payroll gaps:**
  - payroll payout USDC amounts are visible in `wallet_transactions` to any company scope (no employee route reads them)
  - ending a salary and re-creating it for the same pay day can draft a person twice
- **Deploying migration 0050** drops two membership columns; expect a few seconds of errors from the old release during that deploy.

---

## 8. How to build in parallel (what worked in this session)

- **About 5 builders at once.** Seven at once hit the 5-hour usage limit; agents then resume with a message once it resets.
- **Every builder brief includes:**
  - its own test database (`TEST_DATABASE_URL` / `TEST_DATABASE_URL_MIGRATE` prefix)
  - the migration lock (`mkdir apps/api/drizzle/.migration-lock`; edit schema + generate + prettier + "No schema changes" in one go; `rmdir`)
  - the install lock (`mkdir .install-lock`)
  - re-reading shared files right before editing them
  - no commits, no `docs/` edits, no Railway/Doppler, no real providers
  - mutation checks on the key guards
- **Expect transient load failures:** a test run that starts while another builder is writing a migration fails to load. Re-run before concluding anything.
- **Two builders must not change the same hook or service in parallel.** T37 and T39 shared the bill payout hook, so one builder did both.
- **The main session** verifies each report by re-running its tests, runs the integration pass (`pnpm turbo run typecheck lint format`, the API main + serial suites on a fresh database, `db:generate` for drift, shared and mobile tests, builds), updates the docs, then asks Dennis before committing.
- **Guard tests to keep green:**
  - `internal-routes.test.ts`: no staff route can reach payout-creating code
  - `accountant-access.test.ts`: accountants can't change anything
  - `payout-sync.serial.test.ts`
