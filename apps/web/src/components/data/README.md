# Shared data kit

The pieces every company page is built from: the
[shadcn admin template](https://github.com/arhamkhnz/next-shadcn-admin-dashboard)
patterns (KPI cards, TanStack data tables, charts) in the Expendi brand, plus
the mocks' list parts (`docs/mocks/*.html`). See them all, in their states,
at `/dev/preview/kit` (`app/dev/preview/README.md`); the "Template page
patterns" section shows the new table, cards and charts.

## Token mapping (write new code with the right-hand side)

Dark mode and the opt-in colour presets act on shadcn's semantic colours.
`app/styles.css` also flips the raw scale in dark mode, so old classes stay
legible, but only semantic classes follow a preset. Use these:

| Raw token (mocks)                          | Semantic token                                       |
| ------------------------------------------ | ---------------------------------------------------- |
| `text-gray-900`                            | `text-foreground` (`text-card-foreground` on a card) |
| `text-gray-700`                            | `text-secondary-foreground`                          |
| `text-gray-600`, `text-gray-500`           | `text-muted-foreground`                              |
| `text-gray-400` (icons)                    | `text-muted-foreground/70`                           |
| `bg-surface`                               | `bg-card` (panels), `bg-background` (page)           |
| `bg-gray-25`, `bg-gray-50` (row tints)     | `bg-muted/40`, `bg-muted/60`                         |
| `bg-gray-100` (chips, skeletons)           | `bg-muted`                                           |
| `border-gray-200`, `border-hairline`       | `border-border`                                      |
| `border-row-divider`                       | `border-border` (table rows already use it)          |
| `border-control-border`, `border-gray-300` | `border-input`                                       |
| `bg-brand-500`, `text-brand-600`           | `bg-primary`, `text-primary`                         |
| `bg-brand-50` + `text-brand-800`           | `bg-accent` + `text-accent-foreground`               |
| `ring`/`outline` `brand-700`               | `ring-ring`, `outline-ring`                          |
| `rounded-panel`                            | `rounded-xl` (follows `--radius`)                    |
| `shadow-panel`                             | `shadow-xs`                                          |
| `text-error-700`                           | `text-destructive`                                   |
| chart colours                              | `var(--chart-1)` … `var(--chart-5)` (coral first)    |

Keep the status tints as they are (`warn-*`, `success-*`, `error-50`,
`blue-*` in `StatusBadge`, `Callout`, `Banner` and the KPI icon chips): they
have no semantic equivalent and already have dark values.

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
| `stat-cards` `StatCards`, `StatCard`, `StatCardSkeleton`             | The template's KPI cards, at most four, static: `icon`, `tone` (`total`, `attention`, `danger`, `clear`), `label`, `value`, `sub`, `extra`, optional `trend` (`{ direction: "up" \| "down", label }`, a neutral badge).                                          |
| `kind-tabs` `KindTabs`                                               | `label`, `tabs: { value, label, count? }[]`, `value`, `onChange`, `controls`. Leave `count` out while loading. Arrow keys, Home, End.                                                                                                                            |
| `filter-chip` `FilterChip`                                           | `label`, `icon`, `options: { value, label, tone?, mark?, icon? }[]`, `value` (null when off), `onChange`, `anyLabel` ("Any status"), `searchPlaceholder?`, `disabled?`. `tone` shows options as status badges; `mark` shows a payee's initials.                  |
| `filter-chip` `FilterMenuPanel`, `FilterOptionList`                  | The open menu's parts, for static use (the gallery).                                                                                                                                                                                                             |
| `results` `ResultsPanel`                                             | The card around head and body; the `results` container for the phone switch.                                                                                                                                                                                     |
| `results` `ResultsHead`                                              | `tabs`, `chips`, `onClearAll` (pass it only while a filter is set), `stacked` to force chips under the tabs (e.g. Expenses). Otherwise it stacks itself when the chips overflow.                                                                                 |
| `results` `ResultsBody`, `ResultsFoot`                               | `busy` on first load, `refreshing` dims while a filter loads.                                                                                                                                                                                                    |
| `cells` `RowTitle`, `RowMeta`, `Mini`                                | Two-line rows: the name at 600 (a button with `onOpen`), then muted `text` and `Mini` markers (`icon`, `label` read out, optional visible children, `warn`).                                                                                                     |
| `cells` `RowCheckbox`                                                | The custom checkbox; also for checkbox fields in forms. No checkbox on rows that can't be selected.                                                                                                                                                              |
| `cells` `EntityMark`, `initialsOf`                                   | Initials: `kind="business"` (square) or `"person"` (round), `size="md" \| "sm"`.                                                                                                                                                                                 |
| `cells` `PhoneCard`                                                  | One row as a card, for `renderPhoneCard`: `mark`, `title`, `sub`, `flags`, `aside` (amount), `onOpen`, `check`, `selected`. `DataTable` wraps the cards in the `<ul>`.                                                                                           |
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

Cell parts (`cells`) are the pieces a column's `cell` renders: `RowTitle`,
`RowMeta`, `Mini`, `EntityMark`, `RowCheckbox` and `PhoneCard`, plus
`initialsOf` and `isInsideControl` (whether a click landed on a row's own
button, link or field).

Money helpers live in `~/lib/money`: `formatKes` (whole shillings drop the
decimals), `totalsByCurrency`, `usdcToKesCents` and `approxKesTotal({ kes,
usd, rate })` for one "≈ KES" total.

Form fields: use `ui/field` (`Field`, `FieldLabel`, `FieldDescription`,
`FieldError`), `ui/input`, `ui/native-select` and `ui/textarea`; they follow
the mock's side-sheet forms.

## Data table (`data-table`)

TanStack Table v9 on the shared registry in `~/lib/data-table-features`
(`dataTableFeatures`, `DataTableFeatures`, `DataTableColumnDef<T>`,
`DataTableColumnMeta`). Import everything from `~/components/data/data-table`.

```tsx
const columns = useMemo<DataTableColumnDef<Bill>[]>(() => [
  selectColumn({ allLabel: "Select every bill on this page", rowLabel: (b) => `Select ${b.payee.name}` }),
  {
    id: "payee",
    accessorFn: (b) => b.payee.name,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Payee" />,
    cell: ({ row }) => <RowTitle onOpen={() => open(row.original)}>{row.original.payee.name}</RowTitle>,
    meta: { kind: "main", label: "Payee" },
  },
  { id: "amount", accessorFn: amountOf, header: …, cell: …, meta: { align: "end" } },
], []);
const table = useDataTable({ data, columns, getRowId: (b) => b.id });

<ResultsPanel label="Bills">
  <DataTableToolbar table={table} searchLabel="Search bills">{chips}</DataTableToolbar>
  <DataTable table={table} caption="Bills to pay" onRowOpen={open} openRowId={openId}
    loading={query.isPending} empty="No bills to pay." renderPhoneCard={(row) => <PhoneCard … />} />
  <DataTablePagination table={table} noun="bills" />
</ResultsPanel>
```

| Export                                 | Signature / use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useDataTable(options)`                | → `DataTableInstance<T>`. `data`, `columns` (memoize both), `getRowId`; `manual` (`true` or `{ sorting, filtering, pagination }`) when the API sorts/filters/pages, with `rowCount` for the total; `paginate: false` shows every row; `enableRowSelection` (bool or `(row) => bool`). Each slice (`sorting` + `initial`, `pagination` + `initialPageSize` (20), `globalFilter`, `columnFilters`, `columnVisibility` + `initial`, `rowSelection`) is the hook's own unless you pass `{ value, onChange }`. |
| `DataTable`                            | `table`, `caption` (sr-only), `onRowOpen(row)` (clicks on the row's own controls stay theirs), `openRowId` (bar + tint), `loading` + `skeletonRows` (6), `empty` (node), `renderPhoneCard(row)` (cards replace the table under a 720px table or 900px window), `phoneLabel`, `className`. Puts `aria-sort` on sortable headers. Column `meta`: `kind` (`main` truncates and takes the spare width, `date`, `checkbox`), `align: "end"`, `collapse: "md" \| "lg"`, `label`, `className`.                   |
| `DataTableColumnHeader`                | `column`, `title`: a sort button with the direction arrow; plain text when the column can't sort.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DataTableToolbar`                     | `table`, `searchLabel` (shows the search box, wired to the global filter), `searchPlaceholder`, `children` (`KindTabs`, `FilterChip`s), `viewOptions` (Columns menu, default on), `actions`.                                                                                                                                                                                                                                                                                                              |
| `DataTableViewOptions`, `columnLabel`  | The Columns menu; a column's name from `meta.label`, a string header or its id.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DataTablePagination`, `rangeText`     | `table`, `pageSizes` (10/20/50/100), `noun` ("bills"): "21–40 of 134" or "3 of 134 bills selected", rows per page, first/previous/next/last.                                                                                                                                                                                                                                                                                                                                                              |
| `selectColumn({ allLabel, rowLabel })` | The tick-box column (`ui/checkbox`); rows `enableRowSelection` rules out get no box. Read the ticks with `table.getSelectedRowModel()` or own `rowSelection`.                                                                                                                                                                                                                                                                                                                                             |

### Sort helpers (`data-table/sort`)

`SortState<K>` (`{ key, dir }`) is a page's sort. Two ways to wire it to
`useDataTable({ sorting: { value, onChange } })`; both use
`toSorting(sort)` for `value`:

- The page picks the direction (a column starts in its own natural
  direction, e.g. amounts high to low): `onChange: (next) => { const key =
pressedKey(next, sort, KEYS); setSort(nextSort(sort, key, FIRST[key])); }`.
  `pressedKey` reads only the pressed column (the current one when the sort
  clears or the id is unknown); `nextSort(current, key, firstDir)` flips the
  same column or starts another in `firstDir`.
- The table picks the direction: `onChange: (next) => setSort(sortFromTable(next,
sort, KEYS))` takes TanStack's column and direction for a known key and
  flips the current column when the sort clears or the key is unknown, so
  the page's sort never turns off.

## Charts (`trend-chart`, `ui/chart`)

`TrendChart` wraps shadcn's `ui/chart` (Recharts 3): `label` (read out in
place of the drawing), `data` (points), `xKey`, `series: { key, label,
color? }[]` (colours default to `--chart-1…5`, coral first), `kind`
(`area`, stacked when several series, or `bar`), `formatValue` (tooltip),
`formatTick` (axis). Put it in a `Card` with a `CardHeader`. For anything
else, build on `ChartContainer`, `ChartTooltip(Content)` and
`ChartLegend(Content)` from `~/components/ui/chart` directly.

Report-style charts share `chart-tip` (`ChartTip`, `useChartHover`, `TipContent`: the
hover tooltip and its rows), `month-bars` (`MonthBars`, `MonthTip`) and
`table-toggle` (`TableToggle`, `MiniTable`: the chart's table view). Their
pure scale helpers are in `~/lib/chart-scale` (`compact`, `niceScale`,
`kesValue`, `percentChange`, …).

## Shell

`components/app-shell.tsx` is the template's frame (`(company)/layout.tsx`
and the preview use it): `ui/sidebar` (`app-sidebar`, `nav-main`,
`nav-user`), the 48px `site-header` with page search (⌘K / Ctrl+K), the
theme button and the account menu (`components/shell/`). Settings > Appearance
(`settings/_components/appearance-settings.tsx`) saves theme, colours, font,
page width, header and sidebar style in cookies (`lib/preferences/`, store
in `stores/preferences/`); the root layout reads them so the server renders
the right look. A new browser starts light, in the Expendi colours and
Outfit, full width, with a sticky header and an inset sidebar that
collapses to icons. A page can set `data-content-padding="false"` on its root to go
edge to edge. Sidebar badges come from `hooks/use-nav-counts.ts`:
Approvals (`/claims/summary`), Expenses (petty cash missing a document),
Bills (`/bills/summary`) and Payroll (runs to approve or retry).
