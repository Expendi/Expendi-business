# Testimonials spec ("Our customers say it best")

## Overview

- Target: `src/components/sections/testimonials.tsx` → `export function Testimonials()` (`'use client'`)
- Screenshots: `section-testimonials-1440.jpg`, `state-testimonials-after-next.jpg`, `section-testimonials-390.jpg`
- Raw: `raw/testimonials-{1440,768,390}.txt`; timing in `raw/timing-and-mobile.txt` ("TESTIMONIALS")
- Interaction model: **time** + **click** (prev/next arrows) + **drag/swipe**. Final QA confirmed 6-second autoplay, pause on hover, stop after interaction or the last slide. Reduced motion disables autoplay. See `../INTERACTION_QA.md` for measured Swiper configuration.
- Theme dark: `data-header-theme="dark"`, `darkmode`, bg rgb(5,5,5), text #fff.

## DOM Structure

```
section#section-9 py-48 md:py-64 lg:py-80, overflow-x clip
  div container grid (12 cols lg, px 48, max-w 1600; rows 120 | 708 | 80 at 1440)
    header (col-span-full, mb 32 / 40 md / 56 lg): flex-col gap-24 → lg:flex-row lg:items-end justify-between gap-8
      h2 "Our customers say it best" · ButtonLink secondary "Lire les témoignages" (wrapper lg:mb-8)
    carousel (col-span-full, full-bleed at lg: relative left-1/2 w-screen -ml-[50vw]) → inner track max-w 1600 mx-auto, overflow visible
      slide ×4 (lg: width 1249px, margin-right 24px; opacity .5, active 1, transition opacity .35s qonto ease)
        desktop card (hidden lg:block, h-full): relative overflow-hidden rounded-3xl, height 708
          img (object-cover object-top, full)
          blur layer: same img with photo-blur-left-to-right + scrim-dark-left-to-right overlay
          overlay (z-10; only visible on active slide): logo (absolute top-24 left-24, h-40 w-auto, brightness-0 invert) + text block (absolute inset-x-0 bottom-0 p-32 pb-80): div w-[574px] max-w-full → div.lead mb-16 (quote with “ ” spans) + div.body-regular (author)
        mobile card (lg:hidden): image box h-318 md:h-[396px] relative (img rounded-2xl md:rounded-3xl object-cover object-top + overlay bg rgba(5,5,5,0.2) + logo absolute top-16 left-16 h-30) mb-32, then .testimonial-content (lead quote + author body-regular, gap-y-24)
    nav row (relative z-20 col-span-full mt-32): flex justify-end gap-16 → prev / next buttons
```

## Computed Styles

| Element        | 1440                                                                                                                                                                                 | 390                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| section        | padding 80px 0, height 1068                                                                                                                                                          | padding 48px 0                         |
| h2             | 56px/64px w600 #fff                                                                                                                                                                  | 32px/40px                              |
| CTA            | secondary dark, 204×52                                                                                                                                                               | 185×50                                 |
| slide          | 1249×708, margin-right 24px; first visible active at x=48                                                                                                                            | 358 wide (full container), fade effect |
| card radius    | 24px                                                                                                                                                                                 | 16px (24 md)                           |
| logo           | h 40, top/left 24px, `filter: brightness(0) invert(1)`                                                                                                                               | h 30, top/left 16px                    |
| quote (`lead`) | 22px/32px w400 #fff, width 574px, margin-bottom 16px                                                                                                                                 | 18px/28px                              |
| author         | 18px/28px                                                                                                                                                                            | 16px/26px                              |
| text block     | bottom-anchored, padding 32px 32px 80px                                                                                                                                              | –                                      |
| nav buttons    | 48×48 round, bg rgb(61,61,61) (`grey-700`), arrows 24×24 white (`ArrowLeftIcon`/`ArrowRightIcon`, stroke white via `text-primary-white`); disabled opacity .45 + pointer-events none | same, below text                       |

## States & Behaviors

**Desktop (≥1024) slider:**

- Track translateX so the active slide's left edge sits at the container's left padding (x=48 at 1440; slide pitch 1249+24 = 1273px). Not looped: prev disabled on first slide, next disabled on last.
- Initial active slide: index **0** (Poiscaille). Earlier screenshots captured later autoplay states, not random initial slides.
- Click next/prev: GSAP `x` tween **0.5s, `EASE.css`** (measured Swiper speed 500ms, `ease`). Active slide opacity → 1, previous active → 0.5 (0.35s `EASE.qonto`).
- Overlay (logo + quote) of the outgoing slide: opacity 1→0 and y 0→8px, 0.15s `EASE.qontoIn`. Incoming active slide overlay: opacity 0→1, y 8→0, 0.35s `EASE.qontoOut` with 0.15s delay.
- Drag with pointer (cursor grab) to swipe: release past 15% of a slide width or with velocity → go to next/prev, else snap back.
- Arrow buttons hover/click: `ArrowSwap` horizontal — next: arrow exits to +40px and the twin enters from −40px; prev mirrored; 0.3s `EASE.arrow` (Qonto `wr-nav-arrow-*` keyframes, 300ms cubic-bezier(.4,0,.6,1)). Click also triggers it.
- Card hover on Qonto: `translate: 0 -10px` only if the card is a link (these cards are not links → no hover lift).

**Mobile/tablet (<1024) fade slider:**

- Slides stacked; only active visible (Swiper fade). On change: outgoing `.testimonial-content` opacity→0, y→8px (0.15s `EASE.qontoIn`); incoming slide fades in (opacity 0→1, 0.3s `EASE.qonto`) and its content opacity 0→1, y 8→0 (0.35s `EASE.qontoOut`, delay 0.15s). Same prev/next buttons and swipe.
- Initial slide index **0**, matching desktop. The previously observed index 1 was a later autoplay state.

**Reduced motion:** instant switches.

## Per-State Content

| #                                                                       | Photo asset | Logo asset (h-40 / h-30) | Quote                                                                                                                                                                                  | Author                                         |
| ----------------------------------------------------------------------- | ----------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0                                                                       | 34488       | 25709                    | “Qonto adapts as our team grows. No more time-consuming, low-value processes. Employee expense management becomes simple.”                                                             | Oksana Besnier, Financer Manager at Poiscaille |
| 1                                                                       | 34756       | 34546                    | “I needed to move fast when launching my business. Having a platform like Qonto - bringing all the essential services together in one place - was the best solution for me.”           | Pierre-Louis Vouteau, Founder of Ooak Data     |
| 2                                                                       | 34489       | 34545                    | “I'd recommend Qonto to everyone. In my view, it's the ideal financial management solution for all businesses, regardless of their size or needs.”                                     | Pierre-Antoine Errard, Founder of Solarian     |
| 3                                                                       | 34566       | — (none)                 | “I'd recommend Qonto to any entrepreneur looking for more than a bank - a true partner for their projects. I can finally spend time on my sites instead of on the phone with my bank.” | André Schmitte, Founder of AS Projets          |
| Quote marks are separate `<span>`s: `<span>“</span>text<span>”</span>`. |

## Assets

Photos via `QontoImage asset="…"` (`alt=""`, `sizes="(min-width: 1024px) 1249px, 100vw"`). Logos via `QontoImage asset="25709|34546|34545"` (SVG files).

## Text Content (verbatim)

- h2 "Our customers say it best"; CTA "Lire les témoignages" → https://qonto.com/fr/customers (French on the EN page — keep verbatim).

## Responsive Behavior

- `≥1024`: full-bleed horizontal slider (neighbours visible at 50% opacity, clipped by viewport). `<1024`: single fading card, image 318px (396px md) tall, text below.
