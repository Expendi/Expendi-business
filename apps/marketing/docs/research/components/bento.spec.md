# Bento grid spec ("Business account, AI-powered.")

## Overview
- Target: `src/components/sections/bento.tsx` → `export function Bento()`
- Screenshots: `section-bento-1440.jpg`, `section-bento-390.jpg`, mobile state `state-mobile-aside.jpg`
- Raw: `raw/bento-{1440,768,390}.txt`
- Interaction model: **static + in-view Lottie**. The "Pay" card Lottie (`data-wr-lottie-target=fadeIn`) plays when scrolled into view. No click/hover behaviour on cards (hover probe: no diff).
- Theme dark: `data-header-theme="dark"`, class `darkmode`, bg rgb(5,5,5), text #fff.

## DOM Structure
```
section#section-3
  div container grid (12 cols lg) padding 80px 48px, max-w 1600
    div grid (2 cols at lg: 998.5px | 289.5px; rows 64px | 840px; gap 56px 56px)
      [r1 c1] h2 "Business account, " + span.content-tertiary "AI-powered."  (self-center)
      [r1 c2 at lg / last row on mobile] CTA wrapper (lg: self-end, mb 6px) → secondary "Discover our business account"
      [r2 span 2] bento: grid 24 cols × 33px at lg, 4 rows × 192px, gap 24px, height 840px
        card A  Account remuneration   lg: col 1-8,  row 1        (432×192) bordered
        card B  Pay                    lg: col 9-16, rows 1-2     (432×408) radial gradient + Lottie
        card C  Get paid               lg: col 17-24, rows 1-2    (432×408) photo + blur + scrim
        card D  Credit suite           lg: col 1-8,  rows 2-4     (432×624) radial gradient + phone image
        card E  Mastercard cards       lg: col 9-24, rows 3-4     (888×408) photo + blur + scrim
```
Mobile order (`max-lg:order-*`, 6-col grid): A (full) → E (order-2, full) → B and D side by side (order-4, 3 cols each) → C (order-5, full).

## Computed Styles
| Element | 1440 | 768 | 390 |
|---|---|---|---|
| container | padding 80px 48px | 48px 32px | 48px 16px |
| header grid | cols 998.5px/289.5px, gap 56px | 1 col, row-gap 32px | 1 col, row-gap 24px |
| h2 | 56px/64px w600 #fff; span colour **rgb(143,143,143)** | 56/64 | 32px/40px |
| bento grid | 24 cols, rows 192px×4, gap 24px, h 840px | 12 cols, rows 128/471/220/471, gap 16px | 6 cols, rows 130/471/262/471, gap 8px |
| card A | flex column, justify-between, align-start, gap 24px, padding 24px, radius 24px, **border 1px solid rgb(97,97,97)**, min-h 128px, max-h 288px | | flex row, align center, padding 16px, radius 16px |
| card B, D | `flex flex-col-reverse lg:flex-col justify-end`, gap 24px (16 mobile), padding 24px 24px 0 (16px all mobile), radius 24px (16 mobile), bg `radial-gradient(50% 50%, rgb(61,61,61) 0%, rgb(44,44,44) 50%, rgb(26,26,26) 100%)` at lg; **solid rgb(26,26,26)** below lg | | 175×262 each |
| card C, E | flex column justify-between, overflow hidden, padding 24px (16 mobile), radius 24px (16), relative; height 471px below lg | | |
| copy block | flex column gap 16px, max-width 510px (z-10 on photo cards) | | |
| h3 | `h3-small` 24px/32px w600 (20/28 mobile) | | |
| p | `body-regular` 18px/28px (16/26 mobile); B/D p max-width 437px at lg; C/E p margin-bottom 32px | | |
| B Lottie box | `hidden lg:flex` overflow hidden, justify-center, align-end, margin-top auto, 384×256 | – | – |
| D image box | `hidden lg:flex` overflow hidden, align-end, margin-top 88px (auto), 384×384 | – | – |
| B/D mobile icon | `lg:hidden` 40×40 tile, padding 8px, radius 4px, bg rgb(61,61,61), img 24×24 with `brightness-0 invert` | | |
| CTA | secondary, 289×52, 18px/28px | 52px tall | 261×50 16/26 |

Photo cards C and E have three absolute full-bleed layers (top-0 left-0 w-full h-full, pointer-events none):
1. background image, `bg-cover bg-center`
2. same image with `photo-blur-top-to-bottom` (C) — E uses `photo-blur-top-to-bottom` below lg and **`lg:photo-blur-left-to-right`** at lg (blur 6px + mask)
3. scrim: C `scrim-dark-top-to-bottom` (`linear-gradient(rgba(5,5,5,.67) 0%, rgba(5,5,5,.67) 10%, rgba(5,5,5,0) 50%)`); E `scrim-dark-top-to-bottom` below lg, **`lg:scrim-dark-left-to-right`** (`linear-gradient(90deg, rgba(5,5,5,.67) 0% 20%, rgba(5,5,5,0) 60%)`).
Background images are responsive (implement with `bg-[url(...)]` per breakpoint or `image-set`):
- C: `<768` `/qonto/asset/35054/md.avif`; `768–1023` `/qonto/asset/35054/lg.avif`; `≥1024` `/qonto/asset/35054/xl.avif`
- E: `<768` `/qonto/asset/33297/md.avif`; `768–1023` `/qonto/asset/33297/lg.avif`; `≥1024` `/qonto/asset/33298/xl.avif`

## States & Behaviors
- **Pay Lottie** (`/qonto/asset/38018/file.json`, 540×540, 60fps, 300 frames): `<Lottie mode="inview-once" />`. Wrapper has `transition: 0.5s cubic-bezier(.4,0,.2,1)` and is `opacity-100` once loaded → fade it in with GSAP (`opacity 0→1`, 0.5s, `EASE.qonto`) when the animation becomes ready (`onReady`). Lottie should cover the 384×256 box (`preserveAspectRatio="xMidYMid slice"`).
- CTA hover: `rgba(245,245,245,0.08)` bg, instant (globals).
- No other states.

## Per-State Content
N/A.

## Assets
- D phone mock: `QontoImage asset="33887"` alt "WEB ENDE UI  Hero TopicHighlight Bento Headline Cards Financing Simulation DarkMode WbRvmp", `object-cover max-h-[440px] max-w-[440px] lg:max-h-full lg:max-w-full`, inside `picture.h-full.flex.items-end`.
- Mobile icons: B `/qonto/asset/26498/file.svg` alt "WEB Iconography BlackTransfer"; D `/qonto/asset/33263/file.svg` alt "WEB Iconography Black Calendar WbRvmp".
- Photo backgrounds listed above. Lottie 38018.

## Text Content (verbatim)
- h2: "Business account, " + "AI-powered."
- A "Account remuneration" — "Earn up to 5%* on your Qonto account balance."
- B "Pay" — "SEPA & global transfers, virtual cards, & Apple Pay/Google Pay."
- C "Get paid" — "Invoices with embedded payment links, Tap to Pay & POS terminals."
- D "Credit suite" — "A range of working capital solutions, integrated into your business account."
- E "Mastercard debit and credit cards" — "Choose instant or deferred debit. Limits up to €200,000/month."
- CTA "Discover our business account" → https://qonto.com/en/open-an-account

## Responsive Behavior
- `≥1024`: layout above. `768–1023`: 12-col bento (A col-span-12, E 12, B/D 6 each, C 12), CTA below bento. `<768`: 6-col, gap 8px, CTA below (row 3 of header grid).
