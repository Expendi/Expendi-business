# Feature items spec (Trust items + Create your company)

## Overview

- Qonto renders both sections with the same `wr-items-section` block, once dark (section-2) and once light (section-7, followed by the full-width media block section-8).
- Targets:
  - `src/components/sections/feature-items.tsx` → `export function FeatureItems({ items, theme })` shared grid
  - `src/components/sections/trust-items.tsx` → `export function TrustItems()` (section-2, dark, no heading)
  - `src/components/sections/create-company.tsx` → `export function CreateCompany()` (section-7 + section-8)
- Screenshots: `section-trust-{1440,390}.jpg`, `section-company-{1440,390}.jpg`, `section-company-media-1440.jpg`
- Raw: `raw/trust-*.txt`, `raw/company-*.txt`, `raw/company-media-*.txt`
- Interaction model: **static**. Only hover = secondary button bg swap (CSS). No scroll reveals (verified).

## DOM Structure

```
section (data-header-theme, darkmode when dark)
  div.container (padding see table, max-w 1600, mx-auto)
    div.flex.justify-between header row (mb 40 / 56 lg): h2 + desktop-only CTA (self-end) — trust row is EMPTY (height 0, still has the margin)
    grid of 3 items:
      item: icon row (mb 12 / 16 md) → icon tile or image badge
            h3.h3-small (lg mb 8)
            div.body-regular secondary colour > p
    mobile/tablet CTA below grid (company only, `lg:hidden`, pt 40)
```

At lg the grid is `grid-cols-12`, each item `col-span-4 row-span-3` using `grid-template-rows: subgrid` (rows 72px/40px/56px at 1440 → keep heights aligned) with `padding-right: 24px`, column-gap 24px.

## Computed Styles

| Element       | 1440                                                                                                                       | 768                                                                | 390                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------- |
| container     | padding 80px 48px                                                                                                          | 64px 32px                                                          | 40px 16px                     |
| header row    | flex, justify-between, column-gap 48px, margin-bottom 56px                                                                 | mb 40                                                              | mb 40                         |
| h2 (company)  | 56px/64px w600, rgb(5,5,5)                                                                                                 | 56px/64px                                                          | 32px/40px                     |
| grid          | 12 cols × 90px, col-gap 24px; items in 1 row                                                                               | 9 cols, col-gap 16px, row-gap 48px, each item full width (stacked) | 6 cols, row-gap 32px, stacked |
| item          | padding-right 24px (lg)                                                                                                    | –                                                                  | –                             |
| icon row      | flex justify-between, margin-bottom 16px                                                                                   | 16px                                                               | 12px                          |
| icon tile     | 56×56 (48 md, 40 mobile), radius 8px, flex centered; bg **#1a1a1a** dark / **#f5f5f5** light; img 32×32 (28 md, 24 mobile) |                                                                    |                               |
| image badge   | height 56 (48 md, 40 mobile), width auto, radius 8px                                                                       |                                                                    |                               |
| h3            | `h3-small` 24px/32px w600 (20/28 mobile), margin-bottom 8px at lg; colour #fff dark / rgb(5,5,5) light                     |                                                                    |                               |
| body          | `body-regular` 18px/28px (16/26 mobile); colour **rgb(204,204,204)** dark, **rgb(61,61,61)** light                         |                                                                    |                               |
| CTA (company) | secondary button, desktop only in header row (`hidden lg:block`, self-end) 211×52                                          | below grid, `pt-40`, inline                                        | below grid, 191×50            |

Spacing between items stacked (mobile): body → next icon = row-gap.

## Section 8 (company media)

- `section` bg #fff, padding 24px 0 80px at 1440 (`py-40 md:py-80` but measured top 24) → use `pt-24 pb-80 lg:pt-24`, 390: `py-40`.
- container `container-qonto`, then an empty 12-col grid row (0 height, keep for parity is optional).
- `md+`: `div.relative overflow-hidden w-full rounded-2xl lg:rounded-3xl aspect-[8/3] max-h-[504px]` → `QontoImage asset="33897"` `object-cover object-center w-full h-full rounded-2xl lg:rounded-3xl`, alt "Company Creation Upload Document Homepage". 1440: 1344×504 at x=48. 768: 704×264, radius 16.
- `<768`: the media section is hidden, with a zero-height bounding box (reverified against the live site during final QA). The empty square in its hidden DOM contributes no page spacing.
- The UI overlays (upload card, "Customer support" pill) are baked into the photo. Do not rebuild them.

## States & Behaviors

- Secondary button hover: `rgba(29,29,27,0.08)` light / `rgba(245,245,245,0.08)` dark. Instant. Use `ButtonLink`.
- Nothing else animates.

## Per-State Content

N/A (single state).

## Assets

Trust (dark):

1. `QontoImage asset="35272"` badge (French flag tile, 56×56 rendered), alt "WEB Badge Flag France WbRvmp"
2. Tile bg #1a1a1a + `/qonto/asset/3564/file.svg` (32×32, Qonto icon, rendered dark-on-dark, no filter at lg), alt "WEB Iconography Black Qonto"
3. `QontoImage asset="33384"` badge (avatar + "24/7", 120×56 at 1440), alt "Customer Support 24 7 DarkMode"

Company (light, tiles bg #f5f5f5):

1. `/qonto/asset/24698/file.svg` alt "WEB Iconography Black Fast"
2. `/qonto/asset/34341/file.svg` (target icon)
3. `/qonto/asset/26586/file.svg` (headset icon)
   Media: asset 33897.

## Text Content (verbatim)

Trust:

- "Made in France" — "Qonto is a French company headquartered in Paris."
- "750,000+ clients" — "use Qonto daily to run their business."
- "24/7 human support" — "We're available via chat, email, and phone."

Company:

- h2 "Create your company with Qonto"; CTA "Create your company" → https://qonto.com/en/creation
- "Simple and fast" — "Ditch the paperwork. We'll have you up and running in 24 hours."
- "The right fit for your business" — "Qonto works for all business structures: SAS, SASU, SARL, EURL, SCI, and micro-enterprises."
- "We're with you all the way" — "From start to KBIS, we're with you - and available every day to help."

## Responsive Behavior

- `< 1024`: items stack in one column (`col-span-full`), CTA moves under the grid.
- Breakpoints md 768 / lg 1024 (see table).
