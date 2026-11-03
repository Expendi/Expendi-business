# Hero spec

## Overview
- Target: `src/components/sections/hero.tsx` → `export function Hero()`
- Screenshots: `docs/design-references/section-hero-1440.jpg`, `section-hero-390.jpg`
- Raw computed dump: `docs/research/raw/hero-{1440,768,390}.txt`
- Interaction model: **static + time** (looping background video). No scroll/click behaviour. Only hover = button colour swaps (CSS, instant).
- Theme: dark. Root gets `data-header-theme="dark"` and class `darkmode`.

## DOM Structure
```
section#section-1 (relative, bg #050505, min-h: 100svh mobile / 100vh lg)
  picture (lg:hidden)  → mobile poster img 33450, absolute inset-0 z-10, h-svh, object-cover
  picture (hidden lg:block) → desktop poster img 33449, absolute inset-0 z-10, h-screen, object-cover
  video#hero-video  absolute inset-0 z-20 w-full h-svh lg:h-screen object-cover, autoplay muted loop playsInline preload=auto
  div scrim  absolute inset-0 z-30 pointer-events-none h-svh lg:h-screen  (scrim-dark-photo-overlay-gradient utility)
  div.grid content (relative z-40, max-w 1600, mx-auto)
    div.flex-col justify-end (copy column)
      div.flex-col gap  (rating + h1)
        ul > li > a(href https://trustpilot.com/review/qonto.com) inline-flex items-center nowrap
          span "4.7" bold · span "of 5" · img trustpilot logo (73x22)
        h1 > span.block ×3
      div.flex mt (buttons) > div.flex.flex-wrap.gap-16
        ButtonLink primary "Open an account" → https://welcome.qonto.com/signup/select-country
        ButtonLink secondary "Find the right plan" → https://qonto.com/en/pricing
```

## Computed Styles
| Element | 1440 | 768 | 390 |
|---|---|---|---|
| section | bg rgb(5,5,5); min-height 900px (=100vh) | min-h 1024 (100svh), height 1096 | min-h 844 (100svh), height 892 |
| grid content | display grid; 12 cols, column-gap 24px, row-gap 48px; padding 128px 48px 48px; max-width 1600px; height 100vh (`lg:h-screen`); max-height 1264px | 9 cols, padding 96px 32px 48px, row-gap 32px | 6 cols, padding 88px 16px 48px, gap 24px |
| copy column | flex column, justify-end; spans all columns; pb 0 at lg | pb 72px | pb 48px |
| rating+h1 stack | flex column, gap 24px, width 870px | gap 16px | gap 16px |
| rating ul | height 32px, width fit | same | same |
| rating a | inline-flex, align center, 14px/36px w400, color #fff | same | same |
| "4.7" | 14px/36px **w700**, margin-right 4px | same | same |
| trustpilot img | 73×22, margin-left 8px | same | same |
| h1 | **72px/80px w700**, color #fff, lining-nums proportional-nums | **52px/62px** | **28px/36px** |
| h1 spans | display block, one line each | | |
| button row | flex, column-gap 16px, margin-top 48px | mt 32px | mt 32px |
| primary btn | bg #fff, color rgb(5,5,5), padding 12px 16px, radius 8px, 18px/28px (16px/26px <768), 175×52 | | 159×50 |
| secondary btn | transparent, 1px solid #fff, color #fff, padding 11px 16px, radius 8px, 185×52 | | |
| scrim | `linear-gradient(rgba(5,5,5,0) 78.6%, rgb(5,5,5) 100%), linear-gradient(0deg, rgba(5,5,5,.15) 0%, rgba(5,5,5,.15) 100%)` | same | same |

Positions at 1440: h1 top 488 (3 lines × 80), rating top 432, buttons top 800; all left-aligned at x=48.

## States & Behaviors
- **Video**: autoplay, muted, loop, playsInline, `object-fit: cover`. Source switches by viewport:
  - `< 1024px`: `/qonto/video/down-net-http20260612-55-7yckw-lg-original.mp4`
  - `≥ 1024px`: `VIDEO.heroDesktop` (`/qonto/video/web-en-various-16x9-homepage-desktop.mp4`)
  Pick the source client-side with `matchMedia('(min-width: 1024px)')` (component is `'use client'`). With `prefers-reduced-motion: reduce`, do not autoplay: pause the video and leave the poster picture visible (the video sits above it, so hide the video element).
- **Video fade-in** (implement with GSAP): video starts `opacity: 0`; on `playing` event tween to `opacity: 1` over 0.5s, ease `EASE.qonto`. The poster picture shows underneath until then.
- **Buttons**: hover bg primary `rgba(255,255,255,0.92)`; secondary `rgba(245,245,245,0.08)`. Instant (no transition). Already implemented by `.darkmode .btn-*` in globals.css; just use `ButtonLink`.
- No scroll-reveal animations exist on qonto.com for this section (verified: every element is at rest before scroll).

## Per-State Content
N/A — single state (rating list holds one item; verified static over 12s, no cycling).

## Assets
- Desktop poster: `QontoImage asset="33449"` alt "WEB Various HeroFullWidth Homepage Desktop Static WbRvmp", `className="h-full w-full object-cover"`, `priority`
- Mobile poster: `QontoImage asset="33450"` alt "WEB Various HeroFullWidth Homepage Mobile Static WbRvmp"
- Videos: see behaviours. No poster attribute on the `<video>`.
- Trustpilot logo: `staticUrl("trustpilot-logo-with-text-dark.svg")` (73×22), alt "Trustpilot badge"

## Text Content (verbatim)
- "4.7" · "of 5"
- h1: "Business account." / "Finance management." / "Company creation."
- Buttons: "Open an account" · "Find the right plan"

## Responsive Behavior
- Breakpoints: 768 (md) and 1024 (lg). Height: `min-h-svh lg:min-h-screen`; grid `lg:h-screen lg:max-h-[1264px]`.
- `<1024`: copy column height is `calc(100svh - 96px)` (768) / `calc(100svh - 88px)` (390) via `.main-hero-homepage`; simplest equivalent: grid `min-h-full`, copy column `justify-end`.
- Buttons stay side by side at 390 (wrap allowed).
