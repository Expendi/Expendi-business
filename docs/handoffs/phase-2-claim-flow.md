# Phase 2 Handoff: Claim flow

**Linear:** milestone "Phase 2 · Claim flow"

- EXP-279 (T11) Mobile app scaffold and login
- EXP-282 (T12) Company sign-up
- EXP-286 (T13) Staff invites
- EXP-303 (T32) Payout phone verification
- EXP-289 (T14) Submit a claim with a photo
- EXP-292 (T15) M-Pesa SMS parser
- EXP-293 (T16) Read receipts with Claude
- EXP-294 (T17) eTIMS capture
- EXP-295 (T18) Claim rules
- EXP-296 (T19) Approve & pay, and reject
- EXP-298 (T20) Push notifications
- EXP-287 (T21) Wallet screen and withdrawals

**Goal:** the full claim flow in the Expo app. An employee submits, an admin taps Approve & pay, and the money arrives on the employee's M-Pesa.

## Start prompt

> Read `docs/handoffs/README.md`, the Handoff notes in `docs/handoffs/phase-1-money-path.md`, then `docs/handoffs/phase-2-claim-flow.md`. Build Phase 2 one task at a time, in the order listed, reading each task's Linear issue first. Stop at Checkpoint C and go through the QA checklist with me on real phones.

## Read first

- **Spec:** §4 (roles and login), §5 (claim flow and statuses), §6.1–§6.10, §6.18 (payout phone)
- **Build plan:** Tasks 11–21 and 32
- **Consumer Expo app** (`/Users/chizaa/Documents/projects/expendi/recurring-payments-frontend/apps/expo/`):
  - `app.config.ts`, `eas.json`, `package.json`: Expo SDK 54, expo-router, NativeWind, `@privy-io/expo`, expo-camera, expo-local-authentication, expo-notifications, expo-updates
  - `src/`: the Privy login setup (switch it to email + passkeys) and push registration
- **Consumer backend:**
  - `src/services/notification/expo-push-service.ts` and `push-token-service.ts`
  - `src/services/phone-verification/`: the Telnyx Verify flow to port for T32 (`otp-provider.ts`, `telnyx-verify-service.ts`, `phone-verification-service.ts`) and `src/db/schema/phone-verification-challenges.ts`. `phone-normalization.ts` is already ported (`apps/api/src/services/auth/phone.ts`).

## Where things stand

Phases 0 and 1 are done; check their Handoff notes. **Start only when the Phase 2 gate of Checkpoint B has passed** (refund and retry, batch with one failure, crash test; see "Split" in the Phase 1 handoff). Live payouts are proven:

- the payout engine (T8–T10) pays any subject to any method, with batches and caps
- T33 added USDC payouts and the address allowlist

Phase 2B (spending and payments) follows this phase and builds on the claim flow.

## Decisions and inputs needed from Dennis

1. **App identity:** the name and bundle ID. Suggested: "Expendi Business", `app.expendi.business`, as a new EAS project.
2. **Telnyx Verify profile** for T32: reuse the consumer's Telnyx account with a new profile, or a separate account. Keys go in Doppler.
3. **Passkey domain:** the domain that will host `apple-app-site-association` and `assetlinks.json` for T11.
4. **Sample data:**
   - about 50 real receipts, redacted, for the T16 eval
   - real M-Pesa confirmation SMS for each format (Buy Goods, Send Money, Paybill) for the T15 test fixtures

## Tasks, in order

T11 → T12 → T13 → T32 → T14 → T15, T16, T17 (any order) → T18 → T19 → T20 → T21. The T15 parser doesn't depend on anything, so it can be written early.

**Notes**

- **T11:** use the same Expo SDK and Privy Expo versions as the consumer app. Enable Privy's email login and passkeys; the app offers to set up a passkey right after the first email sign-in.
- **T12:** validate the KRA PIN against `^[AP]\d{9}[A-Z]$`. The deposit screen says **"Send USDC on Base only"**.
- **T13:** invites are by email (lowercased). The invite creates the `users` row by email, which first login then claims (already built in T4). A removed member loses access immediately. Set up SPF/DKIM for the invite emails here.
- **T32:** only a confirmed number is written to `users.phone`; payouts read only that column. Kenyan numbers only.
- **T14:**
  - Shrink images on the phone before uploading (long edge about 1600px, JPEG quality about 0.7).
  - Uploads go to a private R2 bucket through signed URLs, under `org/<id>/`.
  - Amounts are stored in integer cents.
- **T16:** validate Claude's output with a zod schema and store the raw result in `expenses.extraction`. Never auto-submit; when the image can't be read, return "couldn't read". Choose the model from the eval results.
- **T17:** decode the QR with the expo-camera barcode scanner and store the raw payload. There is no DigiTax call; that comes after go-live.
- **T18:** duplicate checks include imported claims, which arrive in Phase 3.
- **T14, the `expenses` table:** create it with the `kind` (`claim`/`float`/`company`), `overview_heading`, `float_id` and `paid_from_account` columns from spec §10 now, even though only claims use them in this phase. Phase 2B adds the other kinds, and the rules in T18 apply to all of them.
- **T21:** the address allowlist already exists from T33. This task builds the screens and withdrawals on top of it.
- **T19:**
  - Approve & pay calls the T8 engine with a single-use approval token from the admin's passkey, bound to the claim and amount. It is refused if the employee has no confirmed payout number.
  - Self-approval is allowed and flagged.
  - The cost preview shows KES received, USDC, fee and total.
- **T20:** send pushes asynchronously so they never hold up a request.
- **Every task:** every new route gets an isolation-helper test.

## Environment variables (suggested names)

| Name                                                                     | Purpose                  |
| ------------------------------------------------------------------------ | ------------------------ |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Receipt storage          |
| `ANTHROPIC_API_KEY`                                                      | Receipt reading          |
| `TELNYX_API_KEY`, `TELNYX_VERIFY_PROFILE_ID`                             | Payout phone codes (T32) |
| Resend keys                                                              | Invite emails (T13)      |
| `EXPO_ACCESS_TOKEN`                                                      | Push sending             |
| `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_PRIVY_APP_ID`                        | Mobile app config        |

## Exit criteria: Checkpoint C

- On staging, an employee submits, an admin approves and pays, and the money arrives on M-Pesa
- The isolation helper covers every new route
- Reviewed with Dennis

---

## QA checklist (on real phones)

**Automated**

- [ ] SMS parser fixtures pass for all three formats; unknown text falls back to manual entry
- [ ] Rule tests: exact duplicates are blocked (M-Pesa code, invoice number, file hash, imported claims included); near-duplicates and claims over 60 days old produce warnings
- [ ] KRA PIN validation tests
- [ ] Payout phone tests: wrong, expired and over-limit codes are refused; a non-Kenyan number is rejected; a number confirmed by a second person moves to them
- [ ] Approval tests: a claim pays exactly once, rejecting requires a reason, and self-approval is flagged
- [ ] Isolation tests pass on every new route

**Admin, manual**

- [ ] Create a company: a bad KRA PIN is rejected and a good one accepted. The deposit address and the balance in USDC and KES show.
- [ ] Invite an employee by email: the email arrives, they sign in, and they have the right role
- [ ] Remove a member: they lose access immediately
- [ ] Approve & pay:
  - the preview shows KES, USDC, fee and total
  - a passkey (fingerprint/face) prompt appears
  - M-Pesa receives the exact amount
  - the claim shows Paid
  - a push notification arrives
- [ ] Reject without a reason is blocked. With a reason, the employee sees it, edits and resubmits.
- [ ] Approving your own claim works and is flagged in the audit log
- [ ] Wallet:
  - history shows deposits, payouts and refunds
  - withdrawing to an address that isn't allowlisted is impossible
  - withdrawing to an allowlisted address works after a passkey confirmation

**Employee, manual**

- [ ] Sign in with an email code, set up a passkey, sign out, and sign back in with the passkey
- [ ] Add an M-Pesa number: the Telnyx SMS code arrives and confirms it. Approve & pay is blocked for a claim before that.
- [ ] A photo of a paper receipt pre-fills the fields; the employee confirms and submits
- [ ] An M-Pesa screenshot pre-fills the fields
- [ ] Pasted SMS in each format parses; random text falls back to manual entry
- [ ] Scanning an eTIMS QR fills in the invoice number, and the KRA PIN card is visible
- [ ] The same M-Pesa code twice is blocked, and the same photo twice is blocked
- [ ] A claim with the same amount and date as another shows the admin a warning, and so does a date over 60 days ago
- [ ] Employees see only their own claims

**Across both roles**

- [ ] A user in two companies sees each company's data separately
- [ ] A cheap Android phone on a slow network can upload
- [ ] It works on iPhone, if any pilot staff use one
- [ ] All four push notifications arrive

**Hygiene**

- [ ] Build, typecheck and tests pass; no keys committed; no `as any`, `@ts-ignore` or `@ts-expect-error`
- [ ] T32's issue and EXP-279, 282, 286, 289, 292, 293, 294, 295, 296, 298 and 287 are Done in Linear
- [ ] Checkpoint C reviewed with Dennis

---

## Handoff notes (fill in before ending each session)

- **Status (2026-11-02):**
  - **Code done, device QA pending:**
    - T11 (EXP-279), T12 (EXP-282) and T13 (EXP-286): the app and the API.
    - T32 (EXP-303): the API only. The `payout-number` screen isn't built yet.
    - All four stay In Progress in Linear until their device checks pass.
  - **Code done, verified by tests, uncommitted (2026-11-02, second session block):**
    - T14 (claims with a photo, API + app)
    - T15 (parser only; the "paste SMS" wiring is in progress)
    - T16 (extraction core and eval script; the endpoint is in progress)
    - T21 (wallet history, withdrawals, approval passkeys in the app)
    - Refund linking (Phase 1 known issue)
  - **Code done too:** the T15 wiring, the T16 endpoint, T17 and T18.
  - **T19 code done (2026-11-02):**
    - **Routes:**
      - `POST …/claims/approval` (1–20 claims): requires a confirmed payout phone and a full name; returns the cost preview and passkey options
      - `…/approval/:challengeId/confirm`
      - `…/:claimId/retry` and `…/:claimId/reject` (reason 5–500 characters)
    - **One subject hook** (`services/payout/subjects.ts`):
      - **At approval,** under the approval's locks, the claim is re-checked (still `submitted`, same amount, same confirmed number) and set to `paying`. A refusal rolls back the whole approval.
      - **After every payout status change** (sync, fund, onchain, staff resolve), a claim follows to `paid` or `payout_failed`.
    - **Columns:** `expenses.self_approved` and `expenses.payout_id` (migration 0043).
    - **App:** the approvals queue and pay screen.
  - **T20 and the name fix, code done (2026-11-02):**
    - **Name:** `PATCH /me { fullName }`. The app asks "What's your name?" at first sign-in, which closes the T19 creator-name gap.
    - **Push notifications:** `push_tokens`, plus a `notification_outbox` written in the event's own transaction. Jobs send it: `push-notifications` (lock 72_020, every 5 s) and `push-receipts` (lock 72_021).
    - **Events:** claim submitted (to admins), rejected and paid (to the employee), payout failed (to both).
    - **Recipients** are worked out at send time from active memberships, so removed members get nothing and accountants aren't counted as admins.
    - **Hook for later events:** `notify(tx, event)` in `services/notification/notify.ts`.
  - **All Phase 2 code is done.** Every Phase 2 task waits only for device QA.
  - **Open (T19):** a company creator has no `full_name`, so Approve & pay refuses their own claims. Fix in progress: `PATCH /me { fullName }`, and a name prompt at first sign-in.
  - **How it was built:** in parallel with the Phase 2 gate of Checkpoint B, by subagents, as Dennis decided. See the Phase 1 handoff for the gate results.
  - **QA deferred (Dennis, 2026-11-02):** device QA for Phase 2 (Checkpoint C) and the Phase 2B gate of Checkpoint B are postponed. This is an exception to the README rule that a phase's QA passes before the next phase starts. Code continues in parallel:
    - the Phase 2 tasks T14, T15 (parser), T16 (extraction core) and T21
    - the refund-linking fix
    - Phase 2B's T34 (API)
    - Phase 3's unblocked tasks: T23, then T27, T24 and T30
    - The other Phase 3 tasks (T22, T25, T26, T31, T44) wait for T19 and Phase 2B code. Both QA passes still have to run before go-live.
- **Built:**
  - **T11 app (`apps/mobile`):**
    - Expo SDK 54 with expo-router, NativeWind and React Query. Versions are pinned to what the consumer's lockfile actually runs:
      - `@privy-io/expo` 0.63.6, native-extensions 0.0.7, `react-native-passkeys` 0.3.3
      - React 19.1.0, RN 0.81.5
    - **Login:** email code, then a passkey offer, then `/me`. A passkey sign-in button is on the sign-in screen.
    - **API client:** `src/lib/api.ts`, typed from `@expendi-business/shared`, parses the API's `{ success, error }` envelope.
    - **Isolated pnpm linker works:** no `.npmrc` and no hoisting.
    - **Passkey library:** `react-native-passkeys` takes the same WebAuthn JSON that `@simplewebauthn/server` uses, so the T19 approval passkeys can use it too.
  - **App identity:**
    - "Expendi Business", `app.expendi.business`
    - EAS project `@chizaalabs/expendi-business` (`3c092318-4971-433e-b238-6b4586e09bac`), with the owner pinned in `app.config.ts`
    - channels `development` / `preview` / `production`, `runtimeVersion` fingerprint
    - `EXPO_PUBLIC_*` values are set in the EAS `development` and `preview` environments
  - **Passkey domain files:** `apps/web/public/.well-known/`.
    - The AASA file has Team ID `46XB9S9YV6`.
    - `assetlinks.json` still needs the Android SHA-256 from the first EAS build.
    - Neither is hosted yet.
  - **T12 company sign-up:**
    - **`POST /organizations`:** checks the KRA PIN after trimming and uppercasing. In one audited transaction, it creates the company, the creator's admin membership and the starter categories, then creates the wallet.
      - If wallet creation fails, the company stays and `POST /organizations/:id/wallet` (admin) resumes it.
      - `GET …/wallet` returns `{ status: "creating" }` or the active wallet. A GET never calls Privy.
    - **`categories` table** (RLS FORCE, no DELETE grant), with 13 starter categories. Air travel and Bank & M-Pesa charges are `etims_not_required`.
    - **`GET …/categories`:** any member can read it.
    - **App screens:**
      - create company, with the shared schema checking the PIN on the phone
      - deposit/wallet: "Send USDC on Base only", QR, copy, USDC and KES balance, and "Finish setting up wallet"
      - a company picker for people in several companies
  - **T13 staff invites:**
    - `/organizations/:id/members` is admin only: list, invite, change role, remove.
    - **Each change locks the company row** and re-checks the actor is an admin, so two admins can't remove each other at once.
    - **Last-admin guards** return 409.
    - **Invites:**
      - An invite creates the `users` row by email.
      - It activates on first sign-in (in `authenticate`) or on `GET /me` for an existing login. Each activation is audited.
      - The email goes out through Resend over `fetch` (`services/email/`) after commit. If it fails, the invite stands, and the response carries `emailSent: false` and `installUrl`.
      - **Accountants:** the membership holds the email and name, it is `active` at once, and no install email is sent.
    - **App screens:** team list, invite (with Share/Copy of the install link when the email fails), member detail (role, remove, resend invite).
  - **T32 payout phone (API):**
    - **Routes:** `POST /me/payout-phone`, `/resend` and `/confirm`, a port of the consumer's Telnyx Verify flow with a fetch client.
    - **Limits:** a code lasts 5 minutes, with 5 attempts, a 60 s cooldown, 3 sends per challenge and 5 starts a day. A new cap allows 5 sends per user per hour.
    - **Locking:** the user's row is locked across the Telnyx call.
    - **Confirming:**
      - The `approved` state is saved first, so a retry commits without asking Telnyx again.
      - A number confirmed by someone else moves to them; both changes are audited and both people are emailed (last 4 digits only).
    - `requireConfirmedPayoutPhone(tx, userId)` is exported for T19.
    - **Auth fix:** the `/me` auth middleware is now mounted on `/me/*`, so sub-routes are protected. `GET /me` still gets 401 without a token.
  - **Reconcile fix (Phase 1 engine, found at Checkpoint B):**
    - A funded payout no longer sits in `funding`/`paying` forever.
    - A failed Paycrest fetch of any kind, a 404 included, moves it to `needs_review` only past its threshold: `funding` 10 minutes, `paying` 2 hours (`PAYING_STUCK_MS`, Dennis's decision).
    - A `paying` order that Paycrest still reports as pending after 2 hours also goes to review.
    - The tests run serially (`payout-sync.serial.test.ts`), because reconcile sweeps every company.
  - **Tests:** 466 main + 26 serial in the API, and 18 money-formatting tests in the app. Typecheck, lint, format and the API build all pass.
- **More built (2026-11-02):**
  - **T14:**
    - **Tables:** `expenses` (all §10 columns; status `submitted`/`rejected`/`paying`/`paid`/`payout_failed`/`paid_outside`/`recorded`) and `receipt_files` (plus `uploaded_by`). Migrations 0022/0023 have RLS FORCE and no DELETE grant.
    - **R2 uploads** through presigned PUT URLs (`services/storage/sigv4.ts`, checked against AWS's published example) under `org/<id>/receipts/`. The file is HEAD-checked before a claim can attach it.
    - **Duplicate image** (same sha256 in the company) → 409.
    - **Visibility:** employees see only their own claims; admins see all. Editing is only for the owner while `submitted`/`rejected`, and editing a rejected claim resubmits it.
    - **App:** the claims list, new (camera or library → shrink to 1600 px JPEG 0.7 → sha256 → upload → form → review → submit), detail and edit.
  - **T15:** `parseMpesaSms` in `packages/shared`, 90 synthetic fixtures. Real SMS samples from Dennis are still needed.
  - **T16:**
    - `services/extraction/` with the Anthropic SDK and structured outputs. Every field is validated with zod; on failure it returns `unreadable` with the raw reply kept.
    - `scripts/eval-receipts.ts`. The default model is `claude-opus-5-5` at low effort, until the eval compares it with Sonnet 5.5 and Haiku 5.5.
  - **T21:**
    - **Withdrawals** are payouts with subject `withdrawal`, through the existing onchain engine and every guard. The debit's ledger type is `withdrawal` (migration 0027).
    - **Daily cap:** withdrawals are exempt from it. Spec §7.4 scopes the cap to claims, floats and bills, and moving the company's own money to its passkey-allowlisted address shouldn't be trapped by it. The per-transaction cap still applies.
    - **Approval-passkey enrolment** is `/me/approval-passkey`, admin only. It needs a recent login: both the token's `iat` and Privy's `latest_verified_at` within 10 minutes. Every admin is emailed.
    - **Race fixed:** two outstanding enrolment challenges could create two passkeys.
    - **Wallet history:** `GET …/wallet/history`.
    - **App:** `src/features/approval/` (reusable for T19), and the history, allowed-addresses and withdraw screens.
  - **Refund linking:** see the Phase 1 handoff's Known issues, "Refunds come from Paycrest's Gateway contract (fixed)".
  - **T15 wiring:**
    - A pasted SMS is stored inline (`receipt_files.sms_text`, kind `sms_text`, migration 0032), not in R2. An SMS-only claim is allowed.
    - The API re-parses the SMS and refuses a code or amount that contradicts it.
  - **T16 endpoint:** `POST …/receipts/:id/extract`, for the uploader only.
    - The result is cached on `receipt_files.extraction` (migration 0035) and copied to `expenses.extraction` on submit.
    - Any error is reported as "couldn't read, enter by hand".
    - App: fields read from the receipt are marked "check it", and low-confidence ones are highlighted.
  - **T17:**
    - QR parser in `packages/shared/src/etims-qr.ts` (trusts only `kra.go.ke` hosts).
    - **eTIMS QRs carry the supplier PIN, branch and a signature, not the invoice number.** Only older TIMS (ETR) QRs carry the number, so for eTIMS receipts the number comes from the photo read or is typed. Spec §6.6 is updated.
    - App: a company KRA PIN card. `expo-camera` was added, a new native module, so the dev client must be rebuilt.
  - **T18:** `services/expenses/rules.ts`, generic over every kind of expense.
    - Exact duplicates get a 409 naming the earlier expense (including imported ones).
    - `expenses.warnings` holds `near_duplicate` (same member, same amount, ±1 day) and `older_than_60_days`. Only admins see them.
- **Claude model chosen and eval accuracy:** not yet (T16). It needs `ANTHROPIC_API_KEY` in Doppler and about 50 redacted, labelled receipts.
- **Telnyx Verify profile used:** Dennis's choice is the consumer's Telnyx account with a new Verify profile for Expendi Business. The keys aren't in Doppler yet. Without them the routes return 503 and the API still starts.
- **Changes from spec or plan, and why:**
  - **Spec §10 updated:**
    - `memberships` gains `full_name` (accountants have no user row) and `invited_at`, plus a per-company unique email.
    - `phone_verification_challenges` gains `send_count`, `last_sent_at` and the `approved` status, as in the consumer flow.
  - **The reconcile thresholds above.**
    - Paycrest returned 404 for a refunding order for about 18 minutes at Checkpoint B, then `refunded`.
    - A "404 → review now" rule was built and then dropped (Dennis, 2026-11-02), because it would have flagged payouts that resolve themselves.
  - **Optional env vars:** the Resend and Telnyx variables are optional. Without them, invites and payout-phone codes fail cleanly, and the API and scripts still start.
  - **Linear text corrected:** EXP-279 and EXP-286 were rewritten to match the build plan (email login, email invites).
  - **Re-inviting:** someone already invited only gets the email again. Their role and the audit log are unchanged.
- **Environment variables added:**
  - **API, all optional:** `RESEND_API_KEY`, `EMAIL_FROM`, `APP_INSTALL_URL`, `TELNYX_API_KEY`, `TELNYX_VERIFY_PROFILE_ID`
  - **App:** `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_PRIVY_APP_ID`, `EXPO_PUBLIC_PRIVY_CLIENT_ID`
    - locally in the git-ignored `apps/mobile/.env`
    - for builds in the EAS environments
  - **More API variables, all optional:**
    - receipt uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
    - receipt reading: `ANTHROPIC_API_KEY`, `RECEIPT_MODEL`
  - **For device QA:** `WEBAUTHN_ORIGINS` must include `android:apk-key-hash:<base64url SHA-256 of the signing cert>`. Get the fingerprint from `eas credentials`, then run `tr -d ':' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='`.
- **Known issues and TODOs:**
  - **Adding/removing allowlisted addresses and withdrawing don't email the other admins.** Spec §7.8 does this for payees; it would be a cheap way to notice misuse.
  - **Approval-passkey enrolment depends on Privy's `latest_verified_at`.** Confirm on a device that Privy updates it on sign-in; if it doesn't, enrolment fails closed ("sign in again", which is currently a full sign-out).
  - **R2 presigned uploads haven't run against a real bucket.**
  - **Push needs device setup before QA:**
    - a new dev build (`expo-notifications`, `expo-camera`)
    - Android: a Firebase project, `google-services.json` as the EAS file variable `GOOGLE_SERVICES_JSON`, and the FCM V1 key via `eas credentials`
    - iOS: an APNs key via `eas credentials`
  - **T16:** a receipt read that finishes after the claim was submitted isn't copied to the claim.
  - **T18:** a near-duplicate warning is put on the newer claim only.
  - **T19 must call `requireConfirmedPayoutPhone`** inside its Approve & pay transaction and pay only to the number it returns. Until then, T32's "Approve & pay is refused" criterion is open.
  - **Refunds land as `deposit` rows.** Paycrest refunds come from its Gateway contract (`0x30f6…dd0f`), confirmed twice at Checkpoint B.
    - **Fix:** save the order's on-chain `gateway_id` (it's in Paycrest's `transactionLogs`) on the payout during sync, and classify a Gateway transfer as that payout's `refund` from the Gateway's refund event in the same receipt.
    - **Needed before T21,** whose wallet history must show refunds.
  - **Needed before Checkpoint C:**
    - **SPF/DKIM** for the Resend sending domain.
    - **Host the passkey files** (`apps/web/public/.well-known/`) at `https://business.expendi.app/.well-known/` (HTTPS, `application/json`, no redirect).
    - **Android SHA-256 in `assetlinks.json`,** from the first EAS build.
  - **The `payout-number` mobile screen (T32)** isn't built.
  - **No icon or splash image yet.** On iOS the forms' keyboard avoidance ignores the header height.
  - **Railway pre-deploy migrations (fixed 2026-11-02):**
    - Railway reads `railway.json`'s build and start commands, but never ran its `preDeployCommand`. The 2026-11-02 deploys went live without migrations, and Claude applied 0015–0039 by hand.
    - **Fix:** Dennis set the pre-deploy step in the dashboard (`api` → Settings → Deploy) to `pnpm --filter @expendi-business/api migrate`. Deployment `55fa1870` logs `[migrate] migrations applied` before the server starts.
    - **Before 2026-12-01:** Railway's Config as Code (`railway.json`) is deprecated and stops working that day. Move to Infrastructure as Code (`railway config migrate`), or put the build/start commands in the dashboard and delete `railway.json`.
  - **Railway installs the whole workspace,** mobile included. It's safe, since pnpm only runs esbuild's install script, but slower. Consider an API-only install filter.
- **QA results (date, who ran it, devices used):**
  - 2026-11-02, Claude: automated checks pass (see Tests above). No device runs yet.
- **Next session starts with:**
  1. Build the Android dev client: `eas build --profile development --platform android`.
  2. Add its SHA-256 to `assetlinks.json` and host the well-known files.
  3. Go through the T11–T13 device checks with Dennis.
  4. Build the T32 `payout-number` screen.
  5. Then T14.
