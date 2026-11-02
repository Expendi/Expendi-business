# Pilot distribution and launch

T28 is complete only when staff install from the testing-track invite and an OTA update reaches those installed apps. T29 is complete only after spec §13 passes and the first real claim is paid. Local builds and a public-data import test are preparation, not those outcomes.

## Distribution (T28)

Run commands from `apps/mobile`. Both platforms are prepared until Dennis confirms the pilot's phones.

1. Replace `assets/icon.png` and `assets/icon-foreground.png` with approved Expendi Business artwork. The current files are consumer-app placeholders.
2. In the EAS **production** environment, set `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_PRIVY_APP_ID`, `EXPO_PUBLIC_PRIVY_CLIENT_ID`. Use the intended pilot API environment explicitly; the current deployed API is **dev**. Keep API secrets in Doppler, never in public Expo variables.
3. For Android, set the Firebase `GOOGLE_SERVICES_JSON` file variable for package `app.expendi.business`, and configure the FCM V1 service key through `pnpm dlx eas-cli credentials --platform android`. For iOS, configure APNs and signing through the same command with `--platform ios`.
4. Run the production environment check:

   ```sh
   pnpm dlx eas-cli env:exec --environment production 'pnpm release:check'
   ```

   EAS also runs this check after install on production builds. Android cloud builds verify that the Firebase file names the right package.

5. Build only the platforms staff use:

   ```sh
   pnpm release:build:android
   pnpm release:build:ios
   ```

   Production builds use the `production` EAS environment/channel, fingerprint runtime policy, remote auto-incremented build numbers, and an Android AAB for Play. A preview APK remains available through the existing preview profile when direct installation is needed before store setup.

6. Android: create the app in Play Console, configure a Google Play submission service account using EAS credentials, and perform the initial console upload if Google requires it. Run `pnpm release:submit:android`, select the exact tested build, add the pilot tester emails, and share the **internal testing opt-in link**. Add the **Play App Signing certificate** SHA-256 fingerprint to the site's `assetlinks.json`, and its base64url key hash to `WEBAUTHN_ORIGINS` and Privy. This can differ from the EAS upload/dev signing certificate; test passkeys on a Play-installed build.
7. iOS, if required: create the App Store Connect record for `app.expendi.business` under team `46XB9S9YV6`; run `pnpm release:submit:ios` and select that app/build. Add a beta description, support/privacy URLs and a Privy test account with fixed-code reviewer instructions in App Store Connect (keep the code out of git). Request external TestFlight beta review **a week before go-live**, then invite testers.
8. Record the build IDs, store version/build numbers, invite links, platforms and install results in `phase-4-pilot-launch.md`.

## Verify production OTA

1. Install the tested production build through each testing track. Confirm email login, passkeys and push on real devices.
2. Make a small visible, reversible copy change and run:

   ```sh
   pnpm release:update --message "Pilot OTA verification"
   ```

3. Record the EAS update group ID and runtime fingerprint. Open the installed app on a network, allow the update to download, close it and reopen. Verify the visible change on every pilot platform. EAS Update cannot deliver native dependency/config changes to an incompatible runtime; those require a new store build.
4. Restore the copy through another tested production update. Keep both update IDs and device results as evidence.

## Import and cutover (T25 / T29)

1. Use the internal admin app: Companies → pilot company → **Import spreadsheet**. Invite employees/admins and create categories first. Accountants cannot be attributed expense owners or float holders.
2. Export each source part as UTF-8 CSV, at most 500 rows / 512 KB per file. Map columns, preview, and review all rows with the founder. Correct all errors before importing. The report has no database side effects. Tokens last 30 minutes and expire on API restart or another replica; preview again if asked.
3. Import **payees**, then **salaries / recurring items / unpaid bills**, **unpaid claims**, **open floats**, and **paid history**. Payee payment details are deliberately unset until a company admin adds them through the existing passkey-confirmed flow. Imported staff must already have a company membership.
4. `amount`, `issued`, and `left` are decimal **KES**, not cents and not foreign currencies. Dates are DD/MM/YYYY or YYYY-MM-DD. For weekly schedules explicitly map `scheduleDay` to the ISO weekday (Monday = 1); monthly salary days can be 1–31 and clamp to month end. The `date` is the actual next due/pay date. Schedule/heading/pay-via values use the names shown in the importer.
5. Open float `issued` is the original cumulative issue/top-up total; `left` is the current balance. The difference becomes immutable pre-cutover spending in that float's totals. Import itemized historical purchases separately as `history` under `petty_cash` to populate the overview/export without subtracting them from the opening balance a second time.
6. Paid history is read-only `paid_outside`, has no eTIMS status and never triggers a payout or Zoho sync. Only dates within the last three calendar months are imported. M-Pesa codes enter the ordinary company-wide duplicate checks. History needs a member email to attribute the source record; the founder must choose the correct owner.
7. Preserve source IDs in the CSV even if unmapped: they distinguish two legitimate payments with otherwise identical values. Re-runs of the same rows skip existing imports, independently of filename and column order. Changed source rows are new input, not updates; review them before committing.
8. Record run IDs. Freeze the spreadsheet on cutover day. Reconcile imported totals, every open float, the next salary/bill dates and due amounts with the founder. The public UKEF fixture is for local testing only; it contains GBP payments, not client/KES history.

## Go-live evidence (T29)

Use the complete 18-item checklist in spec §13 and the device/provider checklists in `docs/handoffs/next-session.md`. Each result needs a date, tester and evidence (build/update ID, transaction/claim ID, delivered email/push or founder/accountant confirmation). Do not mark real-world steps complete from unit tests.

- Verify production/pilot environment and provider keys; retain Anthropic's disabled state.
- Set the company's agreed daily cap (pilot checklist: KES 200,000); have its admin fund and authorize money actions.
- Complete payment, refund, payroll, float, reminder, passkey and web tests.
- Obtain founder import sign-off and accountant export/Zoho sign-off.
- Have the company admin approve the first real claim. Record claim ID, paid timestamp, exact amount received and recipient confirmation. Verify the Zoho entry.
- Daily: review alerts and payout queue. Weekly: record submission-to-payment median, Expendi's share of money out, eTIMS coverage, founder overview feedback and staff issues. Day 30: review spreadsheet retirement and accountant rework.

For an incident, pause the affected company's payouts through the internal admin app, diagnose, and unpause after verifying the fix. Never retry an unclear payment automatically.
