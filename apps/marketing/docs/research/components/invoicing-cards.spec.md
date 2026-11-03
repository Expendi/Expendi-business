# Invoicing cards spec ("Compliant invoicing, zero effort")

## Overview
- Target: `src/components/sections/invoicing-cards.tsx` → `export function InvoicingCards()` (`'use client'`)
- Screenshots: `section-invoicing-1440.jpg`, `section-invoicing-390.jpg`
- Raw: `raw/invoicing-{1440,768,390}.txt`; hover diffs in `raw/hover-and-header-states.txt` ("invoicing card 1/2")
- Interaction model: **hover** at ≥1024 (card lift + round arrow + Lottie play); **swipe/click carousel** below 1024.
- Theme light: `data-header-theme="light"`, bg #fff.

## DOM Structure (≥1024)
```
section#section-5 > div.container (padding 80px 48px, max-w 1600)
  div header row: flex-row justify-between items-end gap-8 mb-56
    h2 "Compliant invoicing, zero effort" (56/64 w600 rgb(5,5,5))
    div.mb-8 (hidden lg:flex) > secondary btn "Discover invoicing" (183×52)
  div grid grid-cols-12 gap-32 items-stretch      (cards: 3 × 427px)
    card (col-span-4): relative flex flex-col rounded-3xl, group
      media: relative w-full → div.flex overflow-hidden rounded-3xl aspect-square (427×427)
             bg radial-gradient(66.82% 50% at 50% 50%, rgb(224,224,224) 0%, rgb(245,245,245) 100%)  (= surface-container-gradient-subtle)
             → image or Lottie filling it (h-full w-full rounded-3xl)
             → round arrow: absolute top-16 right-16 z-20 → 32×32 circle bg rgb(232,232,232), ArrowSwap 18px up-right
      copy: mt-16 relative z-20 → flex-col gap-16 pr-12 → flex-col gap-8: h3.h3-small + div.body-regular (colour rgb(61,61,61)) > p
      a.card-link absolute inset-0 z-30 rounded-3xl (whole card clickable)
```

## Computed Styles
| Element | 1440 | 768 | 390 |
|---|---|---|---|
| container | padding 80px 48px | 64px 32px | 48px 16px |
| header | row, align end, gap 8px, mb 56px | column, gap 32px | column, gap 24px |
| h2 | 56px/64px w600 | 56/64 | 32px/40px |
| grid | 12 cols, gap 32px, 1 row 566.7px | carousel | carousel |
| card | 427×567, radius 24px, `transition: translate .25s ease-out` | slide 720 wide, mr 16 | slide 342×472, mr 16px, radius 16px |
| media | 427×427, radius 24px | 720×720 | 342×342 radius 16px |
| round arrow | 32×32, radius 50%, bg rgb(232,232,232), **opacity 0** (transition opacity .1s linear) | | visible on active slide (opacity 1, .3s qonto ease) |
| copy gap | outer gap 16px; inner gap 8px; padding-right 12px | | gap 12px |
| h3 | 24px/32px w600 rgb(5,5,5) | | 20px/28px |
| body | 18px/28px rgb(61,61,61) | | 16px/26px |

## States & Behaviors
**Desktop hover (pointerenter on the card / card-link):**
- Card `translate: 0 -10px` — GSAP `y: -10`, 0.25s, `EASE.cssOut`; back to 0 on leave with the same timing.
- Round arrow container opacity 0 → 1, 0.1s linear (`ease: "none"`); back to 0 on leave.
- Arrow swap: use `ArrowSwap` (`direction="up-right" size={18} duration={0.25} enterDelay={0.15}`) with the card as `triggerRef`.
- Cards 2 and 3: Lottie `mode="hover"` with the card as `hoverRef` (Qonto `onHoverCut`, `play_once`): frame 0 at rest, plays once on hover; holds last frame. Card 1 is a static image.

**Mobile/tablet carousel (<1024):**
- Full-bleed track starting at the container padding (first slide x=16 at 390, x=32... measured translate 16px at 768 too), slides 342px (390) / 720px (768), `margin-right: 16px`, touch/drag to swipe (use pointer events + GSAP `x` tween), snap to slide.
- Navigation below: `flex justify-end gap-16 pt-24 px-16 (md:px-32)`; two 48×48 round buttons, bg rgb(232,232,232) (`surface-control-action-secondary` light), icons `ArrowLeftIcon`/`ArrowRightIcon` 24×24 stroke rgb(5,5,5). Disabled button: opacity .45, pointer-events none (prev disabled on first slide, next on last).
- Slide transition: GSAP `x` tween 0.3s `EASE.css` (Swiper default speed 300ms).
- Arrow buttons hover: ArrowSwap horizontal (`direction="right"`/`"left"`, size 24, duration 0.3) — same micro-interaction as the testimonial arrows.
- The active slide shows its round arrow (opacity 1); its Lottie plays once when it becomes active.

## Per-State Content
| Card | Title | Body | Media | href |
|---|---|---|---|---|
| 1 | Get ready for e-invoicing | As a Certified Approved Platform, Qonto includes fully compliant e-invoicing in all plans. | `QontoImage asset="35243"` alt "WEB  UI  Hero TopicHighlight Bento Headline Cards E Invoicing Compliant WbRvmp" | https://qonto.com/en/invoicing/ |
| 2 | Quotes & invoices, faster with AI | Qonto AI drafts invoices & quotes, you review them. Track status and get paid faster with payment links. | `lottieUrl("40503")` | https://qonto.com/en/invoicing/ |
| 3 | Supplier invoices, minus the admin | AI imports supplier invoices and flags what to check. You review & pay in a click. Reconciliation is automated. | `lottieUrl("40850")` | https://qonto.com/en/invoicing/supplier-invoices |

## Assets
Image 35243, Lotties 40503 and 40850 (540×540, 60fps; fill the square, `preserveAspectRatio="xMidYMid slice"`).

## Text Content (verbatim)
- h2 "Compliant invoicing, zero effort"; CTA "Discover invoicing" → https://qonto.com/en/invoicing (desktop only; hidden below lg on qonto.com).
- Card copy in the table.

## Responsive Behavior
- `≥1024` grid + hover; `<1024` carousel + arrows; header stacks.
