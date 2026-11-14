``# Mobile redesign: implement direction K1

Written 2026-11-11 at the end of the design session. The founder chose the
**K1** design and asked for it to be built into the real Expo app. This document
is enough to start a new session without the earlier conversation.

## Start prompt

> Read `docs/handoffs/mobile-k1-redesign.md`, then `docs/design-system.md` and
> `docs/mocks/mobile/DIRECTION.md`. Run the prototype on the simulator
> (section 3) and look at all seven screens before changing anything. Tell me in
> five lines what you will build and in what order, then implement the
> redesign in the real app following section 6, with parallel subagents where
> the work splits cleanly. Ask before committing.

---

## 1. What was decided

| Decision | Detail |
|---|---|
| Brand | Only design-system tokens: coral 50/100/500/600/700/800, gray 50–900, error 50/700, Outfit. No new brand colours. |
| Quality bar | Chime iOS for colour and type discipline; Kredete for the Home layout. |
| Direction | **K1**: coral top with a pill header, a coral-gradient wallet card peeking behind a white sheet, the big figure, one trend line, round quick actions, soft grey groups. |
| Typography | Outfit everywhere, including list rows (the founder rejected system-font rows). Fixed scale: figure 46 Regular with KES and cents 20/26 muted; screen titles 30 SemiBold; section headings 18 SemiBold; row titles 16 SemiBold over 14 Regular meta; buttons 17 SemiBold; tab labels 11. |
| Icons | Lucide, as the app already uses. Row icons 20 px, stroke 1.75, inside 44 px circles (white on grey groups; error-50 when overdue). Quick actions 24 px in 60 px gray-100 circles. |
| Selected states | Active tab: coral-700 outline icon on a coral-50 pill, coral-700 SemiBold label. Selected filter pill: coral-500 fill, gray-900 label (same pairing as the primary button). |
| Trend colour | One line under the figure. Red (`error-700`) with ↘ when money goes out, green with ↗ when it comes in. Only on white surfaces; on coral, red and green fail contrast. |
| Cards | No dark (`gray-900`) cards on coral; the founder rejected it. Feature cards use the coral gradient with faint white line art and a white pill for the label. |
| Navigation | Five admin tabs: Home · Bills · Expenses · Payroll · Company. Employee tabs: Home · Petty cash · Pay · Profile. Replaces the Overview/Workspace switch and the 13-row Workspace list. |
| Copy | "Reimbursements", never "claims", in visible text (matches the web decision of 2026-11-06). Human dates ("Mon 9 Nov"), never `2026-11-09`. |

Rejected along the way, so do not reintroduce: off-brand palettes (amber,
stamp blue), New York / Archivo / Newsreader, a dark ink band, the black wallet
card, the underlined band link, system-font rows, and the "received this
month" line (not real data).

## 2. Sources

| What | Where |
|---|---|
| **Prototype (source of truth for the look)** | Branch `prototype/mobile-k1` (deleted from the app on 2026-11-11): `apps/mobile/src/app/prototype.tsx`, `apps/mobile/src/features/prototype/{kit.tsx,screens.tsx,fixtures.ts}`, `apps/mobile/src/components/prototype-switcher.tsx` |
| Decisions and history | `docs/mocks/mobile/DIRECTION.md` (brief, audit, keep list, decision log) |
| Earlier HTML explorations (superseded) | `docs/mocks/mobile/explore.html`, `explore-sheet.png` |
| Tokens and rules | `docs/design-system.md`, `apps/mobile/tailwind.config.js`, `apps/mobile/src/theme/colors.ts` |
| Navigation model | memory note "Ramp-aligned navigation": Bills = owed (To pay, Being paid, History), Expenses = spent, Recurring opens from Bills, salaries only on Payroll |

The prototype is committed only on `prototype/mobile-k1`. The redesign is on
`mobile/k1-redesign`. `docs/mocks/` and the Play screenshots are still
uncommitted on `mobile/play-release`. Do not commit anything without asking
Dennis.

## 3. Run the prototype

Check out `prototype/mobile-k1` (or a worktree of it), then:

```bash
cd apps/mobile
pnpm dev                       # Metro for the dev client (port 8081)
pnpm prototype                 # opens expendi-business://prototype?screen=home on the booted simulator
```

On `mobile/k1-redesign` the real screens have a dev-only twin of this:
`pnpm preview` opens `expendi-business://preview?screen=home`, and the handoff
notes below list the other keys.

The debug build at `ios/build/simulator/Build/Products/Debug-iphonesimulator/ExpendiBusiness.app`
already embeds Outfit and `react-native-svg`; install it with
`xcrun simctl install booted <path>` if the simulator was reset. The black
PROTOTYPE pill cycles screens; `?screen=` takes `home`, `review`, `bills`,
`expenses`, `payroll`, `company`, `employee`. The route redirects in release
builds and is registered only when `__DEV__` in `src/app/_layout.tsx`.

## 4. Screen-by-screen mapping

| Prototype screen | Real route(s) and code | Data already available | New or missing |
|---|---|---|---|
| Home (admin) | `src/app/(app)/index.tsx`, `features/overview/home-content.tsx` (`AdminHomeContent`), `workspace-navigation.tsx` | `GET /organizations/:id/overview` (`spendingOverviewSchema`): `cash.availableKes`, `cash.totalKes`, `cash.through`, `cash.balanceUsdc`, `cash.rate`, `outstanding.*`, `cash.obligations` | Eye toggle (hide balance, persisted locally); KES/USDC pill (client-side conversion with `cash.rate`, handle `rate === null`). Keep the cash-check states: `covered`, `short` (show `shortKes` in red), `unknown`. |
| Review reimbursement | `(admin)/approvals/index.tsx`, `(admin)/approvals/[claimId]/pay.tsx`, `features/claims/*` (`use-claim-approval.ts`, `claim-actions.tsx`, `claim-warnings.tsx`, `sms-evidence.tsx`), `features/approval/*` (passkey gate) | Claim queue, claim detail, SMS/eTIMS evidence, duplicate warnings, pay + reject mutations | "After paying, KES X is available" = `availableKes − claim amount` (compute client-side from the overview query). "1 of 3" pager over the queue. Duplicate warnings must stay visible above the actions. |
| Bills | `(admin)/bills/index.tsx`, `bills/[billId]/*`, `bills/new.tsx`, `bills/pay.tsx`, `features/bills/*` (`bill-groups.ts`, `use-bills.ts`), `(admin)/recurring/*` | `useOpenBills`, `useBillHistory`, bill groups | Pills To pay · Being paid · History (Ramp model); "Recurring" pill opens the recurring list; coral + opens New bill. Bills that belong to a payroll run stay off this list. |
| Expenses | `(admin)/spending/*`, `features/spending/*`; employee claims under `(employee)/claims/*` | Overview `currentKes`, `previousKes`, `headings`, `categories`, `recentPayments` | Month pill reuses `?month=` on the overview query. Filter pills All · Reimbursements · Petty cash · Company map to `recentPayments[].channel` / `kind`; confirm with the API before building. |
| Payroll | `(admin)/payroll/index.tsx`, `payroll/runs/[runId].tsx`, `payroll/salaries/*`, `features/payroll/*` | `useSalaries`, payroll runs, `usePayPayroll` | Next-run gradient card, people with initials, past runs. Staff roles in the prototype are invented; show the payout method instead unless the API has a role. |
| Company | `(admin)/wallet/*`, `(admin)/team/*`, `(admin)/payees/*`, `(admin)/export.tsx`, `(admin)/petty-cash/floats/*`, `select-company.tsx`, `(onboarding)/create-company.tsx`, account + sign-out from `(app)/index.tsx` | Wallet, team, payees, floats, export hooks | New tab-root screen. "Zoho Books · synced 2 hours ago" is invented: show it only if a mobile-readable sync status exists, otherwise drop the row. |
| Home (employee) | `EmployeeHomeContent` in `home-content.tsx`, `(employee)/claims/new.tsx`, `(employee)/petty-cash/*`, `(employee)/salary-payments.tsx` | `useClaimList`, `useFloats({ mine: true })`, `useMySalaryPayments` | "Owed to you" = sum of submitted, unpaid claims; green trend = the latest payment to the employee. Quick actions Add receipt · Paste SMS · Scan eTIMS route into the existing claim editor's three evidence modes (`receipt-picker`, `sms-evidence`, `etims-scanner`). |

Not designed yet (keep their current UI, restyled with the new components):
new bill, bill detail, the "how do you want to add it?" sheet, and the employee
Petty cash / Pay / Profile tabs.

## 5. Components to build

Promote these from `features/prototype/kit.tsx` into `src/components/` as real,
typed components (rewrite, don't copy; the prototype skipped loading, error and
accessibility states):

- `CoralHeader` (pill header: initials, company-switcher pill, bell with dot) and the coral top + white `Sheet` overlap.
- `GradientCard` (SVG gradient, white line art, `WhitePill`, white Expendi mark via `expo-image` `tintColor`).
- `MoneyFigure` (KES and cents small and muted, tabular figures, hide-balance mask).
- `TrendLine` (direction → colour and arrow).
- `QuickActions` (60 px circles, count badge).
- `SoftGroup` + `ItemRow` (icon circle or initials avatar, title, meta tone, amount or "Add amount", chevron). Replace `ListRow` call sites gradually.
- `SectionHeader` (title, coral count badge, action link), `FilterPills`, `RoundButton`, `PillButton`, primary/secondary buttons (56 px, 16 px radius), `DetailHeader` (round back button), `KvGroup`.
- Tab layout: convert `src/app/(app)/_layout.tsx` (currently a `Stack`) to expo-router `Tabs` with a custom tab bar matching the prototype, separate admin and employee tab sets by role. Keep the existing guards (full-name step, company states) in front of it.

Tokens: add `success: { 50: "#ecfdf3", 700: "#067647" }` to `tailwind.config.js`
and `colors.ts`, and record it plus these in `docs/design-system.md`: section
headings SemiBold, card radius 24 (soft groups) / 22 (gradient cards), 56 px
primary buttons. Remove `mono: ["Outfit"]` confusion only if nothing depends on it.

## 6. How to build

1. **Shell first, alone:** tokens, the new components (section 5), the Tabs
   layout with both tab sets, and the admin Home on live data. Verify on the
   simulator against `?screen=home` before anything else.
2. **Then in parallel** (up to five subagents, exclusive file ownership, the
   main session integrates and verifies): Review + approvals · Bills ·
   Expenses · Payroll · Company · Employee home. Each builder gets this
   document, the prototype screen file, the mapping row above, and must not
   touch API behaviour, routes outside its area, or financial calculations.
3. **Keep every existing behaviour** (see the keep list in `DIRECTION.md`):
   routes, permissions, passkey approval, duplicate warnings, rate-unavailable
   and cash-short states, employee/admin scoping, pull-to-refresh, loading,
   empty and error states.
4. **Delete the prototype** from the app once each screen ships: the
   `prototype` route, `features/prototype/`, `prototype-switcher.tsx`, the
   `__DEV__` screen in `_layout.tsx` and the `prototype` script. Per the
   prototype skill, first commit the prototype to a throwaway branch
   `prototype/mobile-k1` (ask Dennis), so it stays a reference without
   living on main.

## 7. QA checklist

- [ ] `pnpm --filter @expendi-business/mobile typecheck`, `lint`, `test` pass (272 mobile tests at last count).
- [ ] Each screen matches its prototype screen side by side on the iPhone 17 Pro simulator, light mode.
- [ ] Android emulator: tab bar pill, Outfit weights, SVG gradient and shadows render (no iOS-only styles).
- [ ] Largest Dynamic Type / font scale: rows wrap, nothing clips, figure still fits.
- [ ] States: loading skeletons, empty, API error with retry, `rate === null`, cash `short`, no reimbursements, no floats.
- [ ] Admin vs employee: employees never see company data or admin tabs.
- [ ] Approving still requires the passkey; returning a reimbursement still asks for a reason.
- [ ] Contrast: no red/green text on coral; white text only on the darker part of gradient cards.

## 8. Open questions for Dennis

1. Hide-balance eye and KES/USDC switch: build now or later? (Both are new; the prototype only shows them.)
2. Company tab: is there a mobile-readable Zoho sync status, or drop that row?
3. Employee "Owed to you": sum of submitted + approved-but-unpaid, or submitted only?
4. Should the old Overview month breakdown live only on Expenses (as designed), with nothing on Home?

## Handoff notes

_Fill in at the end of each implementation session: what was built, what's left, anything that changed._

### 2026-11-11, session 1: all seven screens built (uncommitted)

**Built.**
- Tokens: `success-50/700`. Components in `src/components/` per section 5, plus `CoralScreen`, `TabScreen`, `LoadError`, `Avatar` and `CappedText`.
- `(app)/_layout.tsx` is now `Tabs` with role-specific bars:
  - Admin: `index`, `bills`, `expenses`, `payroll`, `company`.
  - Employee and accountant: `index`, `me/petty-cash`, `me/pay`, `me/profile`.
  - Bills and Payroll were git-moved into `(app)/`. Every other route is still a root-stack screen.
- Screens live in `features/*/…-screen.tsx`: admin Home, Review + approvals queue, Bills, Recurring list, Expenses, Company spending list, Payroll, Company, employee Home, Pay, Petty cash and Profile.
- `home-content.tsx` and `workspace-navigation.tsx` are deleted.
- Visible copy says "reimbursement" throughout, and "Rejected" now reads "Returned".

**How to look at it without signing in.** `expendi-business://preview?screen=<key>` (dev only) renders the real screens against zod-checked fixtures through a fake read-only `ApiClient` and session (`src/app/preview.tsx`, `src/features/preview/`). Keys include `home`, `home-short`, `home-norate`, `review`, `approvals`, `bills`, `expenses`, `payroll`, `company`, `employee-home`, `pay`, `petty-cash` and `profile`, plus empty, loading and error variants. Each screen was compared side by side with its prototype screen on the iPhone 17 Pro simulator. Admin Home was also checked on the Pixel 7 emulator and at the largest accessibility text size.

**Answers to section 8 (defaults taken; change if wrong).**
1. Eye and KES/USDC are both built:
   - The eye is stored in SecureStore and covers both balances.
   - USDC = available ÷ `cash.rate`, rounded down.
   - Short shows "Short by"; no rate shows the wallet's USDC.
2. There is no Zoho row. The only status endpoint is staff-only (`/internal/companies/:id/zoho`).
3. Owed to you = submitted + paying + payout_failed, summed over every page.
4. The month breakdown lives on Expenses only. Expenses also has the category breakdown.

**Other decisions.**
- The bell opens approvals for admins and reimbursements for employees.
- Accountants get the employee tab set.
- Staff roles, the masked M-Pesa number, purchase times and "paid on" dates for payroll runs aren't in the API, so the screens show the payout method, "number confirmed", the date and the pay day instead.

**Left.**
- A live signed-in pass on a real account.
- Done: the prototype is saved on `prototype/mobile-k1` and deleted from the app. The preview harness is kept (dev only).
- Founder questions:
  - API filter for payroll bills (filtered on the client now).
  - "USD" label on bills.
  - More than 20 recent payments on Expenses.
  - A job title on salaries.
  - A paid-on date for payroll runs.
