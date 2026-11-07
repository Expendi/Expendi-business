# Shared data kit

The pieces every company page is built from, matching `docs/mocks/*.html`
(the `:root` tokens and shared CSS of `bills.html` and `expenses.html`). See
them all, in their states, at `/dev/preview/kit` (`app/dev/preview/README.md`).

## Tokens (`app/styles.css`)

- Colours: `brand-50…800`, `gray-25…900`, `warn-50/600/700`,
  `success-50/700`, `error-50/700`, `blue-50/500/700`, `surface`, `hairline`,
  `row-divider`, `control-border`, `scrim`. The mock's text colours are
  `gray-900` (text), `gray-600` (text-2) and `gray-500` (text-3).
- Radii: `rounded-control` (8px), `rounded-panel` (14px), `rounded-full`.
- Shadows: `shadow-panel`, `shadow-menu`, `shadow-selection-bar`,
  `shadow-[var(--shadow-sheet)]`.
- Weights by role, never above 600: `font-(--w-display)`, `--w-heading`
  (400), `--w-title`, `--w-name`, `--w-strong`, `--w-button`, `--w-figure`
  (600), `--w-amount`, `--w-ui` (500).
- Motion: `motion-safe:animate-rise | pop | fade | skeleton`,
  `ease-out-expo`. The global reduced-motion rule stops the rest.
- Buttons (`ui/button`): `default` is the coral primary (white, 600);
  `outline`, `ghost`, `danger` (red ghost), `quiet` (icon). Sizes: `md` is
  the mock's 36px `.btn`, `default` its 44px `.btn-lg`, `icon-md` 36px square.

## Components

| Import                                                               | Use                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page-header` `PageHeader`                                           | `title`, `subtitle`, `actions` (buttons, full width under 600px).                                                                                                                                                                                                |
| `stat-cards` `StatCards`, `StatCard`, `StatCardSkeleton`             | At most four static cards: `icon`, `tone` (`total`, `attention`, `danger`, `clear`), `label`, `value`, `sub`, `extra`.                                                                                                                                           |
| `kind-tabs` `KindTabs`                                               | `label`, `tabs: { value, label, count? }[]`, `value`, `onChange`, `controls`. Leave `count` out while loading. Arrow keys, Home, End.                                                                                                                            |
| `filter-chip` `FilterChip`                                           | `label`, `icon`, `options: { value, label, tone?, mark?, icon? }[]`, `value` (null when off), `onChange`, `anyLabel` ("Any status"), `searchPlaceholder?`, `disabled?`. `tone` shows options as status badges; `mark` shows a payee's initials.                  |
| `filter-chip` `FilterMenuPanel`, `FilterOptionList`                  | The open menu's parts, for static use (the gallery).                                                                                                                                                                                                             |
| `results` `ResultsPanel`                                             | The card around head and body; the `results` container for the phone switch.                                                                                                                                                                                     |
| `results` `ResultsHead`                                              | `tabs`, `chips`, `onClearAll` (pass it only while a filter is set), `stacked` to force chips under the tabs (e.g. Expenses). Otherwise it stacks itself when the chips overflow.                                                                                 |
| `results` `ResultsBody`, `ResultsFoot`                               | `busy` on first load, `refreshing` dims while a filter loads.                                                                                                                                                                                                    |
| `table` `DataTable`                                                  | `caption` (screen readers), `thead`/`tbody` children. Hidden under a 720px panel or a 900px window, where `PhoneCards` show.                                                                                                                                     |
| `table` `Th`, `SortHeader`, `nextSort`                               | `SortHeader` sets `aria-sort` and the arrow; `nextSort(current, key, firstDir)` flips or starts a column. `collapse="md" \| "lg"` hides a column under 900/960px of panel; `checkbox` for the select column.                                                     |
| `table` `DataRow`                                                    | `open` (its sheet is showing), `selected`, `onOpen`; clicks on its controls stay theirs.                                                                                                                                                                         |
| `table` `Td`                                                         | `kind`: `main` (takes the spare width, truncates), `date`, `checkbox`; `align="end"` for amounts.                                                                                                                                                                |
| `table` `RowTitle`, `RowMeta`, `Mini`                                | Two-line rows: the name at 600 (a button with `onOpen`), then muted `text` and `Mini` markers (`icon`, `label` read out, optional visible children, `warn`).                                                                                                     |
| `table` `RowCheckbox`                                                | The custom checkbox; also for checkbox fields in forms. No checkbox on rows that can't be selected.                                                                                                                                                              |
| `table` `EntityMark`, `initialsOf`                                   | Initials: `kind="business"` (square) or `"person"` (round), `size="md" \| "sm"`.                                                                                                                                                                                 |
| `table` `PhoneCards`, `PhoneCard`                                    | The same rows as cards: `mark`, `title`, `sub`, `flags`, `aside` (amount), `onOpen`, `check`, `selected`.                                                                                                                                                        |
| `table` `TableSkeletonRows`                                          | Loading rows inside `<tbody>`: `rows`, `columns`.                                                                                                                                                                                                                |
| `status-badge` `StatusBadge`                                         | `tone` (`waiting`, `moving`, `paid`, `failed`, `rejected`, `quiet`, `overdue`) and the label. No dot.                                                                                                                                                            |
| `money` `Money`                                                      | `amount` in minor units (KES cents; USD and USDC in USDC base units), `currency` `KES \| USD \| USDC`. The code is small and muted.                                                                                                                              |
| `money` `KesTotal`                                                   | One KES figure from `approxKesTotal(...)`, with a muted "≈" when USD was converted.                                                                                                                                                                              |
| `money` `AmountStack`                                                | Amount cell: the amount, and `sub` such as `≈ KES 5,805 today`. `align`, `size="inherit"` in a sheet header.                                                                                                                                                     |
| `detail-sheet` `DetailSheet`                                         | The right sheet: `open`, `onClose`, `eyebrow`, `title`, `headerExtra`, `headerActions`, `stepper` (`index`, `total`, `onStep`, labels), `stepKey` (the open id), `footer`, `flush`, `dismissible`. Escape and the scrim close it; focus goes back to the opener. |
| `detail-sheet` `SheetActions`, `SheetPosition`, `ReadOnlyNote`       | Footer parts: `kind="primary"` buttons, `kind="secondary"` ghost buttons pushed right, "N of M", the view-only note (`wide` for its own line).                                                                                                                   |
| `detail-sheet` `DetailList`, `DetailItem`, `SectionLabel`, `Callout` | Sheet body parts: label/value rows (`sub` line), small section labels, tinted notes (`warn`, `error`, `neutral`).                                                                                                                                                |
| `use-deep-link-param` `useDeepLinkParam(name)`                       | `[value, setValue]` for a query param, written with `router.replace`. The page needs a `<Suspense>` boundary.                                                                                                                                                    |
| `selection-bar` `SelectionBar`                                       | Sticky multi-select bar: `summary`, `links`, `action`.                                                                                                                                                                                                           |
| `banner` `Banners`, `Banner`                                         | Page messages: `tone` (`neutral`, `success`, `warn`), `icon`, `title`, body children, `actions`, plus `role`/`aria-label`.                                                                                                                                       |
| `states` `EmptyState`, `ErrorState`, `Skel`                          | Empty (`icon`, `title`, text, `action`), failed load (`title`, text, `onRetry` for "Try again"), a loading bar.                                                                                                                                                  |
| `actions` `IconButton`, `TextLinkButton`, `textLinkClass`            | 36px icon button with a required `label`; the coral underlined link.                                                                                                                                                                                             |

Money helpers live in `~/lib/money`: `formatKes` (whole shillings drop the
decimals), `totalsByCurrency`, `usdcToKesCents` and `approxKesTotal({ kes,
usd, rate })` for one "≈ KES" total.

Form fields: use `ui/field` (`Field`, `FieldLabel`, `FieldDescription`,
`FieldError`), `ui/input`, `ui/native-select` and `ui/textarea`; they follow
the mock's side-sheet forms.

## Shell

`components/app-shell.tsx` is the frame (`(company)/layout.tsx` and the
preview use it). Sidebar badges come from `hooks/use-nav-counts.ts`:
Approvals (`/claims/summary`), Bills (`/bills/summary`) and Payroll (runs to
approve or retry). Expenses has no badge yet; add it there.
