# Site header spec (fixed nav, theme swap, mega menus, language picker, mobile drawer)

## Overview
- Target: `src/components/layout/site-header.tsx` → `export function SiteHeader()` (`'use client'`). Sub-components may live in `src/components/layout/header/*.tsx`.
- Screenshots: `qonto-full-1440.jpg` (top), `state-megamenu-{0..5}.jpg`, `cookie-banner-1440.jpg` (header behind banner); mobile drawer `state-mobile-menu-open.jpg`, `state-mobile-menu-category.jpg`.
- Raw: `raw/header-{1440,768,390}.txt`, `raw/megamenu-{0..5}.txt`, `raw/header-390-{closed,open,category}.txt`, header rows in `raw/hover-and-header-states.txt`.
- Data: `NAV_MENUS`, `COUNTRIES` from `~/content/navigation` (verbatim labels, hrefs, icons, highlight cards).
- Interaction model: **scroll** (theme follows the section under the bar), **hover** (desktop mega menus, language picker), **click** (mobile drawer + category sub-panels).

## DOM Structure
```
header#nav-revamp  fixed top-0 inset-x-0 z-[100000], height 80 (lg) / 64 (mobile)
  nav#navigation  backdrop-blur 6px, bg per theme (see states)
    div.flex justify-between items-center px-20 lg:px-48
      div.flex items-center lg:h-80 grow
        a[href=/en] QontoLogo 82×24 (wrapper pb-8 mr-32 at lg → logo top 23px)
        ul.nav-menu (desktop: flex-row gap-24, each li h-80 flex items-center) — 6 triggers
          li: button > span 16px/20px w400 + mega-menu panel (absolute)
      div.flex items-center gap-x-16 (right)
        lang switch (hidden lg:flex): button gap-8 px-10 → EuropeFlag 16 rounded-full · "en" uppercase 16/26 · CaretDownIcon 9×6
        a "Sign in" (hidden lg:block) 16/26, py-4
        a.btn btn-primary "Open an account" 16px/24px, padding 12px 16px (390: text-12, py-4 px-12, mr-24), radius 8
        button.hamburger (lg:hidden) 27×64
  div overlay: fixed left-0 top-80 w-full h-screen bg #050505 -z-10, opacity 0 (0.5 when a mega menu is open)
```

## Computed Styles
| Element | 1440 | 390 |
|---|---|---|
| nav (dark theme) | bg `rgba(5,5,5,0.7)` (scrim-emphasis), `backdrop-filter: blur(6px)`, text #fff, logo `filter: brightness(0) invert(1)` (i.e. white), primary btn bg #fff text rgb(5,5,5) | same |
| nav (light theme) | bg `rgba(255,255,255,0.7)` (scrim-default), blur 6px, text rgb(5,5,5), logo black, primary btn bg rgb(5,5,5) text #fff | same |
| inner row | padding 0 48px, height 80 | padding 0 20px, height 64 |
| nav items | gap 24px; x positions 162, 318, 476, 606, 676, 752; text 16px/20px | hidden |
| lang button | x=1069, 82×26, padding 0 10px, gap 8px | in drawer |
| Sign in | x=1168, 50×34, 16px/26px; hover colour rgb(97,97,97) (instant) | in drawer |
| Open an account | x=1233, 159×48, 16px/24px, radius 8px | 12px text, padding 4px 12px, right margin 24px |
| hamburger | – | 27×64; three 27×2 bars (8px apart) white on dark / rgb(5,5,5) on light |

## States & Behaviors
1. **Theme follows section** — sections carry `data-header-theme`. Use `useSectionTheme(80)` desktop / `useSectionTheme(64)` mobile (choose via matchMedia; the probe line is the header's bottom edge — verified on qonto.com: switches exactly when a section's top reaches y=80). Tween `backgroundColor` between `rgba(5,5,5,0.7)` and `rgba(255,255,255,0.7)` with GSAP 0.5s `EASE.cssOut`; text/logo/button colours swap instantly. Header never hides on scroll.
2. **Mega menu (≥1024, hover)** — hovering an li (or its 80px-tall hit area) opens its panel; leaving the li + panel closes it (a 24px invisible bridge under the trigger keeps it open while moving down).
   - While open: nav bg becomes solid #fff (`bg-primary-white`), text rgb(5,5,5), logo black, primary button black; the hovered item stays rgb(5,5,5) and the other nav items fade to `rgba(26,26,26,0.7)` (color transition 0.2s).
   - Overlay `opacity 0 → 0.5`, 0.3s `EASE.cssOut` (Qonto keyframe `overlayFadeRevamp`), back to 0 on close.
   - Panel: `position:absolute; top:96px; left:-32px` relative to the li; bg #fff; radius 32px; overflow hidden; z 1000; inner `flex gap-24 p-32`. Columns are `ul` of width 273px; highlight column 273px with `mb-8`. Panel sizes at 1440: menu0 1228×476 (x130), menu1 931×426 (x286), menu2 931×470 (x444), menu3 931×426 (x255), menu4 634×254 (x644, no highlight), menu5 634×452 (x720). Panel appears instantly (no transition on qonto.com); add a GSAP fade 0→1 over 0.15s max only if needed for polish — default: instant.
   - Category label: `li` 14px/22px rgb(61,61,61), margin 32px 0 6px (first one mt 0).
   - Item link: flex items-center, padding 14px 0, 16px/26px rgb(5,5,5); icon 22×22 `mr-10`. Hovering an item turns all *other* items rgb(97,97,97) (grey-600) incl. their icon strokes/fills; transition 0.2s `EASE.qonto`.
   - Highlight card: `a.group` flex-1, min-h 284, max-h 335, mb-16, radius 8px, bg `surface-container-gradient-subtle`; image `QontoImage` (`aspect-[10/7] h-full w-full object-cover rounded-lg`, 273×284–308); round arrow 32×32 bg rgb(232,232,232) `absolute top-16 right-16` with `ArrowSwap` (0.25s) on card hover. Below: `<strong>` title 18px/28px w700, description 16px/26px.
3. **Language picker (hover on desktop, click on mobile)** — panel `div.block` 326px tall, 292px content width: title "Select your country" (18/28 bold, mb 8), subtitle "Explore our country-specific features in your preferred language." (14/22, mb 16), then two columns (`w-1/2`) of country links (16×16 round flag + label). Caret rotates 180° (0.4s `EASE.cssOut`). Countries: `COUNTRIES` (Europe/EN current). See `raw/hover-and-header-states.txt` "lang switch" for geometry; render white card, radius 16px, shadow `0 4px 24px rgba(0,0,0,.08)` positioned under the button.
4. **Mobile drawer (<1024, click hamburger)** —
   - Hamburger → X: middle bar fades out, top/bottom bars move to center and rotate ∓45° (GSAP 0.25s `EASE.qonto`); reverse on close.
   - Header bg turns solid #fff; a 1px rgb(184,184,184) bottom border scales in from the right (`scaleX 0→1`, 350ms, ease cubic-bezier(.54,0,.2,1)).
   - `#nav-menu` panel: absolute top-0 inset-x-0, height 100vh (844), bg #fff, `padding: 96px 20px 32px`, flex column justify-between, overflow scroll, `z-index:-1`; slides `x: 100% → 0` (0.35s `EASE.qonto`).
   - Top level list: buttons `w-full flex justify-between items-center py-14`, label `h3` 24px/32px w600, `ChevronRightIcon` 16×16. Below the list: language button (EuropeFlag + "EN" + caret).
   - Bottom: full-width primary button "Open an account" (350×50, 16/26, radius 8, bg rgb(5,5,5) text #fff) and centred "Sign in" with 1px rgb(5,5,5) bottom border, `pb-7`, margin-top ≈32px.
   - Tapping a category opens a sub-panel (slides in from the right over the list, 0.3s `EASE.qonto`): header shows a back arrow (`ArrowLeftIcon`-style 24×24 at x=20; slides in from x+39.5px with opacity 0→1, 0.15s, 0.15s delay) and the category title centred (16px/26px rgb(61,61,61), fade 0.15s linear). The logo hides while a sub-panel is open. Content: groups with category label (14/22 rgb(61,61,61), mt 32, mb 6) and item rows (icon 20×20 mr-10, label 16px/26px, py-13) — highlight card below the groups (image 310px tall, radius 8). Back arrow returns to the list.
   - Body scroll locked while the drawer is open.
5. **Reduced motion**: all of the above switch instantly.

## Per-State Content
Use `NAV_MENUS` (6 menus × groups × items, 5 highlight cards) and `COUNTRIES`. Header texts: "Sign in" → https://app.qonto.com/detectapp.html?appUrl=/ · "Open an account" → https://welcome.qonto.com/signup/select-country · language "en".

## Assets
`QontoLogo`, `EuropeFlag` and country flags, `CaretDownIcon`, `ChevronRightIcon`, `ArrowIcon`, `Menu*Icon`s (all in `~/components/icons`), highlight images via `QontoImage asset=...`.

## Text Content (verbatim)
Nav: "Business account", "Company creation", "Financial tools", "Credit", "Pricing", "About us". Language panel: "Select your country", "Explore our country-specific features in your preferred language.", "Europe". All menu labels from `NAV_MENUS`.

## Responsive Behavior
- `≥1024`: desktop row, mega menus. `<1024`: logo + "Open an account" + hamburger (768 uses 16px button text, `md:py-12 md:px-16`).
- Header height 80 (lg) / 64.
