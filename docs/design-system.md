# Expendi Business design system

## Brand source and direction

This is a brand-preserving product UI refresh. The reference is the sibling
`miniapp/frontend/src/app/globals.css`: Outfit, coral `#ff7e5f`, coral tints,
and cool gray neutrals. The logo source is
`recurring-payments-frontend/apps/expo/assets/icon-foreground.png`: the coral
interlocking Expendi mark. Browser copies trim the transparent app-icon padding
and center the original pixels on a square canvas without redrawing the mark.
`crypto-budget-app/frontend/src/app/globals.css` also establishes the use of
Outfit and shadcn semantic tokens across Expendi products.

Design-taste settings: DESIGN_VARIANCE 3, MOTION_INTENSITY 2, VISUAL_DENSITY 5.
Use its brand preservation, hierarchy, and layout guidance; product controls
use the existing official shadcn/Radix foundation, and mobile uses native
React Native controls.

## Tokens

- Primary buttons: coral 500 `#ff7e5f` with white SemiBold (600) labels, coral 600
  on hover. The founder chose this on 2026-11-06 knowing white on coral 500 is
  2.50:1, below WCAG AA; coral 700 with white (4.72:1) is the accessible option.
  Button labels never contain amounts.
- Links and selected controls: coral 700 `#cc4528` / 800 `#a63620`.
- Selected surface: coral 50 `#fff4f0`.
- Workspace: gray 50 `#f9fafb`; cards and navigation: white.
- Primary text: gray 900 `#101828`; secondary: gray 600 `#475467`;
  muted: gray 500 `#667085`.
- Borders: gray 200 `#e4e7ec`; control borders: gray 300 `#d0d5dd`.
- Error: `#b42318`; status colors communicate state, not decoration.
- Success (mobile): 50 `#ecfdf3`, 700 `#067647`, from the same Untitled UI
  family as the gray scale. Only for money coming in (the green trend line)
  and paid states; never on coral, where red and green fail contrast.

Browser tokens live in each app's existing `src/app/styles.css` and are kept
identical. Legacy `stone-*` classes alias the Expendi gray scale while screens
are migrated to semantic tokens. Native tokens live in
`apps/mobile/tailwind.config.js`. Both browser apps retain their explicit
dark-token definitions; the current product remains light by default.

## Geometry and typography

- Outfit everywhere; tabular figures for amounts. Native body text is 16/24px.
- Browser type scale (size/line height, weight). Weight follows size: large
  figures stay Regular and small anchors use SemiBold. 600 is the heaviest
  weight in the product; no Bold or ExtraBold.
  - Display 32/40px, 400: the Overview title and the wallet balance only.
  - Heading 24/32px, 400: page and section headings. Stat card figures use the
    same size at 600.
  - Title 18/26px, 600: card, panel and side-panel titles.
  - Row 16/24px: the name a row is about at 600, its amount at 500.
  - Body 14/20px, 400; links, pills and group labels at 500; buttons at 600.
  - Label 12/16px: field labels at 500, count badges at 600, captions and
    legends at 400.
  - Chart axes and date tiles may use 11px; nothing else goes below 12px.
- Currency codes (KES, USDC) sit before the number at 0.72em, Medium, in the
  muted text color; the number carries the weight.
- Existing screens still use semibold page headings; move each one to this
  scale the next time it changes.
- 4px spacing scale. Browser page gutters: 16px phone, 24px tablet, 32px desktop.
  Content is capped at 1440px. Header: 64px; navigation rows: 44px.
- Browser controls: 44px default, 36px compact (44px on coarse pointers),
  48px large. Inputs and adjacent buttons share a height.
- Native controls: minimum 48px; height grows with text scaling. Labels can
  wrap without clipping. Native content is capped at 768px with 20px gutters.
- Browser controls: 8px corners; panels: 14px. Native fields: 12px; native
  groups, cards and buttons follow the K1 geometry under Mobile.
- Cards group distinct financial information; nested tables do not need
  another card or shadow. Table cells use 16px horizontal / 12px vertical padding.

## Layout and interaction

- Grid children and flex text columns must shrink (`min-w-0`). Do not conceal
  layout problems with page-level `overflow-x-hidden`.
- Tables scroll inside their panels; amounts remain readable and aligned.
  Long names wrap, email/account labels truncate with their full value available.
- Toolbar actions wrap as a group on narrow screens. Labels stay above inputs.
- Preserve keyboard focus, disabled/busy states, and reduced-motion preferences.
- Bottom sheets scroll and avoid the keyboard; safe-area padding stays intact.
- Keep existing routes, permissions, API behavior, and financial calculations.

## Mobile reference and implementation

The mobile reference is `recurring-payments-frontend/apps/expo`, especially its
`src/components/ui`, `src/components/layout`, and `src/theme/colors.ts`.
Business uses the same NativeWind styling approach, Lucide React Native icons,
Expo Image for the original mark, Expo Haptics for section selection, and
Reanimated for reduced-motion-aware loading transitions. Native colors passed
to icons and navigation are defined in `apps/mobile/src/theme/colors.ts`.

- Direction K1 (2026-11-11, `docs/handoffs/mobile-k1-redesign.md`): coral top with
  a pill header, a coral-gradient card peeking behind a white sheet, the big
  figure, one trend line, round quick actions, soft grey groups. The shared
  pieces live in `apps/mobile/src/components/` (`CoralScreen`, `CoralHeader`,
  `GradientCard`, `MoneyFigure`, `TrendLine`, `QuickActions`, `SoftGroup`/
  `ItemRow`, `SectionHeader`, `FilterPills`, `TabScreen`, `DetailHeader`,
  `KvGroup`, `TabBar`).
- Native type scale: figure 46 Regular with the currency code and cents
  20/26 muted; tab-root titles 30 SemiBold; section headings 18 SemiBold; row
  titles 16 SemiBold over 14 Regular meta; buttons 17 SemiBold; tab labels 11.
- Native geometry: primary and secondary buttons 56px with 16px corners
  (secondary is a gray-100 fill); soft groups 24px corners on gray-50 with
  hairlines between rows; gradient cards 22px; row icons 20px, stroke 1.75,
  in 44px circles (white on grey groups, error-50 when overdue); quick
  actions 24px icons in 60px gray-100 circles. Fields keep 52px.
- Selected states: the active tab is a coral-700 outline icon on a coral-50
  pill with a coral-700 SemiBold label; a selected filter pill is coral-500
  with a gray-900 label, the same pairing as the primary button.
- No gray-900 cards on coral. White text only on the darker part of a
  gradient card.
- Navigation: admins get five tabs, Home · Bills · Expenses · Payroll ·
  Company; employees and accountants get Home · Petty cash · Pay · Profile.
  Wallet, team, payees, export, floats, switching company and signing out
  live on the Company tab (Profile for employees). Employee screens use
  employee-scoped data; company management remains admin-only.
- Sign-in and verification use the original logo and a centered, scrollable,
  keyboard-aware form. Native headers use the same cool-gray workspace surface.
- Wallet and overview balances use tabular figures, distinct amount and label
  hierarchy, and explicit unavailable-rate states.
- Shared rows, error callouts, empty states and confirmation sheets carry the
  same icon, typography and spacing rules across existing screens.

## Browser navigation groups

- Company app: **Workspace** (Overview, Accounts), **Spend & pay** (Approvals,
  Expenses, Bills, Payroll), **Manage** (Payees, Team, Settings), **Insights**
  (Reports, Activity). Recurring payments open from the Bills page, not the
  sidebar. Accounts keeps the `/wallet` route.
- Operations app: **Operations** (companies, payouts), **Monitoring** (alerts,
  system health), **Administration** (controls, audit log, Zoho Books).

Groups use shadcn `SidebarGroup` and `SidebarGroupLabel`, keep the current-page
indicator, and scroll inside the sidebar on shorter screens.

## Company data pages

The approved mocks in `docs/mocks/` are the reference. The model follows Ramp:
Bills are money still owed to suppliers (To pay, Being paid, History);
Expenses are money already spent and never list spending linked to a bill;
salaries appear only on Payroll. Visible text says "reimbursement", never "claim".

- Stat cards show numbers only, at most four, and are never clickable.
- Tabs with counts split a list by stage or kind. Filter chips (dashed, icon,
  label, chevron) open listbox menus; the highlighted option is coral 50 with
  coral 800 text and no border. Up to five chips share the tabs' row; more,
  or not enough width, stacks them under the tabs.
- Status badges are a colour tint plus text, with no dot.
- Tables are one flat list with sortable headers and no group header rows.
  Rows have two lines: the name at 600, then a muted meta line with small
  markers. Rows that can't be selected have no checkbox. Under a 720px panel
  the table becomes cards. There is no horizontal page scroll.
- Totals that mix KES and USD show one "≈ KES" figure at today's rate; rows
  keep their own currency.
- Details open in the right side sheet, step with the arrow keys ("N of M")
  and have a deep-link query parameter.

## Admin page patterns

- Audit filters, payout queues, alerts, health, controls, company and payout
  details, imports, and Zoho use the same browser typography and spacing.
- Compose operational panels from shadcn Card parts. Shared `PageLoading`,
  `PageError`, and `PageEmpty` use Skeleton, Alert, and Empty primitives, with
  announced loading and error states and contextual empty-state text.
- Tables use the shared keyboard-focusable horizontal scroll region. Long
  company names, identifiers, provider errors, and JSON values wrap within cells.
- Use 44px Input/NativeSelect controls and shadcn button variants. Long action
  labels can grow vertically; action groups wrap instead of overflowing.
- Sync status filters are pressed buttons in a labelled group. Pause and
  resolution retain their reason, evidence, review, and confirmation steps.
- Import layout selection, mapping, preview and review gates retain their
  existing behavior; their controls and preview table follow the same patterns.

## Verification (2026-11-02)

- 50 browser layout cases: actual overview and company-directory components
  rendered in an isolated harness with sample API data, at 320/390/768/1024/1440px,
  in populated, long-content, empty, error, and loading states. No document-width
  overflow, clipped button labels, or runtime errors. Mobile navigation opened
  and closed with Escape.
- Live web sign-in checked at 320/390/1440px. Default action height: 44px.
- After grouping navigation, nine focused browser cases passed, including
  group/link counts, active links, sidebar scrolling, Escape dismissal, and
  no page overflow at 320/768/1440px.
- Admin page parity: 138 isolated browser cases passed across ten screens at
  320/768/1440px, covering populated, long-content, empty, loading, and error
  states where applicable. No document overflow, clipped action labels, runtime
  errors, or form controls below 44px. Long company names wrap in pause actions
  and navigation links.
- Seventeen admin interaction checks passed: pause/resolution review and
  back/cancel, audit details and filter routing, Zoho status filters/retry/mapping/
  connect link/disconnect cancellation, company lookup validation, import
  mapping/preview/review gating, and read-only action visibility. These used
  isolated sample APIs; no live financial actions were performed.
- Desktop and narrow admin captures were visually reviewed. Admin typecheck,
  lint, and production build passed; the dev app responds at localhost:3001.
- Contrast: coral button/dark label 7.10:1; muted text/white 4.97:1;
  selected navigation 6.14:1; error text 6.05:1.
- Admin and web production builds passed. Admin/web/mobile typechecks and lint
  passed. Existing web/mobile suites: 425 tests passed.
- iOS simulator build passed with Expo Image and Expo Haptics linked. Build with
  simulator ad-hoc signing enabled (`CODE_SIGN_IDENTITY=-`), rather than
  `CODE_SIGNING_ALLOWED=NO`, so Keychain-backed authentication can initialize.
- Native sign-in and invalid-email validation passed on iPhone 17 Pro (iOS
  26.2), including text entry and the submit action with the keyboard open.
- Isolated native fixtures exercised the actual home and shared components:
  Overview/Workspace selection, grouped navigation and scrolling, employee
  visibility, long company names and balances, error/loading/empty states,
  and confirmation-sheet text entry, keyboard avoidance, and dismissal.
  Rendered home, workspace, long-content, sign-in and keyboard-sheet captures
  were visually reviewed. The simulator was restored to the real sign-in.
- Live authenticated and payment flows still require a signed-in account.
