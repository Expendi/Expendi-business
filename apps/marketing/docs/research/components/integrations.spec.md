# Integrations spec ("Keep all your tools connected")

## Overview
- Target: `src/components/sections/integrations.tsx` → `export function Integrations()` (`'use client'`)
- Screenshots: `section-integrations-1440.jpg`, `section-integrations-390.jpg`
- Raw: `raw/integrations-{1440,768,390}.txt`
- Interaction model: **scroll-gated looping Lottie** (logo orbit around a Qonto disc). No hover/click.
- Theme light: `data-header-theme="light"`. Section bg #fff with a full-bleed radial-gradient layer.

## DOM Structure
```
section#section-6 relative overflow-hidden bg #fff
  div absolute inset-0 (bg radial-gradient(66.82% 50% at 50% 50%, rgb(224,224,224) 0%, rgb(245,245,245) 100%))  = surface-container-gradient-subtle
  div container grid (12 cols lg, padding 80px 48px, max-w 1600)
    div wrapper (lg: grid 12 cols, col-gap 24, min-h 504, content-center; <lg: flex-col items-center px-24 pt-32 overflow-hidden text-center min-h 624)
      div copy (z-10, grid 6 cols, lg: col-span-6 pl-64 py-64)
        h2 "Keep all your tools connected" (col-span-6)
        div.body-regular mt-16 (lg col-span-5) > p
        div empty (flex-col gap-16 mt-48) — 0 height at lg (mt 32 mb 48 on mobile)
      div media (relative z-10 w-full h-full, lg: col-span-6 col-start-7 row-start-1 justify-end pr-64)
        div absolute flex center, size 760 (lg) / 624 (md) / 496 (mobile)
            lg: left 0, top 50%, translateY(-50%)  → at 1440 box is x 732..1492, y 4103..4863 (section 4151..4815), so it overflows right and is clipped by the section
            <lg: left 50%, top 0, translateX(-50%)
          Lottie (w-full h-full)
```

## Computed Styles
| Element | 1440 | 768 | 390 |
|---|---|---|---|
| section | 1440×664, overflow hidden | 768×920 | 390×720 |
| container | padding 80px 48px; 12 cols × 90px; col-gap 24 | padding 64px 32px; 9 cols × 64px, col-gap 16 | padding 48px 16px; 6 cols |
| wrapper | display grid (12 cols), min-h 504px | flex column center, padding 32px 24px 0, min-h 792 | flex column center, padding 32px 24px 0, overflow hidden, min-h 624px, text-center |
| copy | 660×376, padding 64px 0 64px 64px; rows 128/72/48 | 496 wide, centred | 310 wide |
| h2 | 56px/64px w600 rgb(5,5,5), 2 lines ("Keep all your tools" / "connected"), x=112 y=4359 | 56/64 centred | 32px/40px centred |
| body | 18px/28px, margin-top 16px, width 497 (col-span-5) | 18/28 | 16px/26px, mt 12px |
| media column | 660×376, padding-right 64px, justify-end | | 310×342 |
| Lottie box | 760×760 | 624×624 | 496×496 |

## States & Behaviors
- Lottie `lottieUrl("34192")` (760×760 comp, 30fps, 601 frames = 20s). On qonto.com it plays from frame 0 when the section is on screen at 30fps (measured: frame 18→215 over 6.5s ≈ 30fps) and **pauses when the section leaves the viewport** (resumes from the paused frame when it returns). Attributes `data-lottie-min-frame-value=0`, `data-lottie-max-frame-value=70` mark the intro (frames 0–70); after the first full pass loop the remainder: play `[0, 601]` once, then loop segment `[70, 601]` (use `mode="manual"` + `onReady` and a ScrollTrigger `onToggle` to play/pause; on the lottie `complete` event call `playSegments([70, 600], true)` with `loop = true`).
- Wrapper fade-in: Lottie wrapper has `transition: 0.5s cubic-bezier(.4,0,.2,1)` and `opacity-100` once loaded → GSAP fade 0→1 (0.5s, `EASE.qonto`) in `onReady`.
- Reduced motion: show last-frame (or frame 70) still, no playback.

## Per-State Content
N/A.

## Assets
Lottie 34192 (logos — Google Drive, ACD, Stripe "S", Sage, Amazon, Cegid, WhatsApp, etc. — are inside the Lottie, not separate images).

## Text Content (verbatim)
- h2 "Keep all your tools connected"
- p "Connect over 2,000 external tools & accounts directly to Qonto - let all your data sync automatically."

## Responsive Behavior
- `≥1024`: copy left (x=112), orbit right, vertically centred, clipped by section.
- `<1024`: centred copy on top, orbit below (top-aligned, horizontally centred, clipped by the wrapper's overflow hidden / section).
