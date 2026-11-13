# Shared data kit

The pieces the admin pages are built from: the
[shadcn admin template](https://github.com/arhamkhnz/next-shadcn-admin-dashboard)
patterns (KPI cards, TanStack data tables, charts) in the Expendi brand. The
files are copies of the ones in `apps/web`, which is the source of truth, so
change them there first. See the pages that use them at
`/dev/preview/<page>` (`app/dev/preview/README.md`).

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

## Components

| Import                                                                                                                       | Use                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page-header` `PageHeader`                                                                                                   | `title`, `subtitle`, `actions`.                                                                                                                                                                                                          |
| `stat-cards` `StatCards`, `StatCard`, `StatCardSkeleton`                                                                     | KPI cards, at most four: `icon`, `tone`, `label`, `value`, `sub`, `extra`, optional `trend`.                                                                                                                                             |
| `data-table` `useDataTable`, `DataTable`, `DataTableToolbar`, `DataTablePagination`, `DataTableColumnHeader`, `selectColumn` | TanStack Table v9 on `~/lib/data-table-features`; import everything from `~/components/data/data-table`. Sort helpers (`nextSort`, `toSorting`, `pressedKey`, `sortFromTable`) are in `data-table/sort.ts`.                              |
| `trend-chart` `TrendChart`                                                                                                   | A Recharts 3 area or bar chart on `ui/chart`, coloured from `--chart-1…5`.                                                                                                                                                               |
| `status-badge` `StatusBadge`                                                                                                 | `tone` (`waiting`, `moving`, `paid`, `failed`, `rejected`, `quiet`, `overdue`) and the label.                                                                                                                                            |
| `states` `EmptyState`, `ErrorState`, `Skel`                                                                                  | Empty, failed load (with "Try again") and loading bar.                                                                                                                                                                                   |
| `cells` `RowTitle`, `RowMeta`, `Mini`, `EntityMark`, `RowCheckbox`, `PhoneCard`                                              | Cell parts a column's `cell` renders, plus `initialsOf` and `isInsideControl` (whether a click landed on a row's own button, link or field). `DataTable` renders its own phone-card list; `PhoneCard` is one card for `renderPhoneCard`. |

The full prop tables are in `apps/web/src/components/data/README.md`.

## Shell

`components/app-shell.tsx` is the template's frame (`(staff)/layout.tsx` and
the preview use it): `ui/sidebar` (`app-sidebar`, `nav-main`, `nav-user`),
the 48px `site-header` with page search (⌘K / Ctrl+K), the theme button and
the account menu (`components/shell/`). Settings > Appearance
(`(staff)/settings/_components/appearance-settings.tsx`) saves theme,
colours, font, page width, header and sidebar style in cookies
(`lib/preferences/`, store in `stores/preferences/`); the root layout reads
them so the server renders the right look. A new browser starts light, in
the Expendi colours and Outfit, full width, with a sticky header and an
inset sidebar that collapses to icons.
