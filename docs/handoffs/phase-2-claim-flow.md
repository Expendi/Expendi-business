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

Phases 0 and 1 are done; check their Handoff notes. Live payouts are proven:

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

- **Status:**
- **Built:**
- **Claude model chosen and eval accuracy:**
- **Telnyx Verify profile used:**
- **Changes from spec or plan, and why:**
- **Environment variables added:**
- **Known issues and TODOs:**
- **QA results (date, who ran it, devices used):**
- **Next session starts with:**
