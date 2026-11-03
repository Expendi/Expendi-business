# Qonto AI spec (topic highlight with auto-advancing steps)

## Overview
- Target: `src/components/sections/qonto-ai.tsx` → `export function QontoAi()` (`'use client'`)
- Screenshots: `section-ai-1440.jpg` (step 1 active), `state-ai-step3.jpg` (step 3 active), `section-ai-390.jpg`
- Raw: `raw/ai-{1440,768,390}.txt`, timing log `raw/timing-and-mobile.txt` (section "AI-TABS")
- Interaction model: **time-driven + click** at ≥1024 (auto-advancing steps with a vertical progress bar, click jumps); **click accordion** below 1024.
- Theme light: `data-header-theme="light"`, bg #fff, text rgb(5,5,5).

## DOM Structure (≥1024)
```
section#section-4 > div.container(px 48, max-w 1600)
  div.grid 12 cols (82px each), col-gap 24px, padding 80px 48px  (so content starts at x=96)
    div.col-span-5 flex-col gap-48
      h2.h2-small "Qonto AI." + <p> "Your choice, your control." (block, second line)
      div.flex-col gap-8   ← 3 steps
        step: div.flex.items-stretch.cursor-pointer (opacity 1 active / 0.4 inactive, transition opacity .5s)
          div.w-2 shrink-0 > div track (w-full h-full rounded-full bg rgb(184,184,184) overflow hidden)
                                  > div bar (w-full h-0 rounded-full origin-top bg rgb(5,5,5))
          div.flex-1 px-40 py-32 rounded-r-xl  → h3.h3-small mb-8 + p (body-regular)
      ButtonLink secondary "Discover Qonto AI"
    div.col-span-6 col-start-7 flex center
      div.relative overflow-hidden rounded-3xl size-[740px] shrink-0   (overflows the column: x 668→1408)
        img ai_gradient_background (absolute inset-0 object-cover)
        3 × div.absolute.inset-0 (opacity 1 active / 0, transition opacity .5s cubic-bezier(.4,0,.2,1)) > Lottie
```

## Computed Styles
| Element | 1440 | 390 |
|---|---|---|
| inner grid | padding 80px 48px; 12 cols; col-gap 24px; row 740px | (mobile block) padding 40px 16px |
| h2 | 40px/48px w600 rgb(5,5,5), 506 wide, 2 lines (p is its own line) | 28px/36px, mb 24px |
| steps stack | gap 8px; each step 506×152 | |
| track | 2px wide, full step height, radius 9999px, bg rgb(184,184,184) | |
| bar | bg rgb(5,5,5), height grows 0→100% of track | |
| step pane | padding 32px 40px, radius 0 12px 12px 0, transition colors .3s | |
| h3 | 24px/32px w600, mb 8px | 20px/28px |
| p | 18px/28px w400 | 16px/26px |
| CTA | secondary light (1px solid rgb(5,5,5)), 183×52, margin-top = gap 48px | `mt-32`, `w-fit` |
| media box | 740×740, radius 24px, overflow hidden | 343×343 (`size-[343px]`), radius 16px |

## States & Behaviors
**Desktop auto-advance (GSAP timeline):**
- Starts when the section enters the viewport (ScrollTrigger `start: "top 80%"`), pauses when it leaves (`onLeave`/`onLeaveBack`), resumes on re-enter.
- Active step i: step opacity 1 (others 0.4, `opacity` tween 0.5s linear-ish — use `EASE.css`); its bar tweens `height: 0% → 100%` with `ease: "none"` over the step's Lottie duration; other bars are reset to 0 instantly.
  Durations (from the JSON: frames / fps): step 1 = 540/60 = **9s**, step 2 = 450/60 = **7.5s**, step 3 = 450/60 = **7.5s**. Measured on qonto.com: bar grows ≈16.9px/s on the 152px track (= 9s) and switches to step 2 right as it fills.
- Media: the active panel's wrapper fades to opacity 1, others to 0 (0.5s, `EASE.qonto`); the active Lottie restarts from frame 0 and plays once (`mode="manual"`, control via `onReady` → `goToAndPlay(0, true)`; pause the others).
- After step 3 completes → back to step 1 (loop).
- **Click** on any step: jump to it immediately (restart its bar from 0 and its Lottie), continue auto-advancing from there. Verified: clicking step 3 sets opacities 0.4 | 0.4 | 1 within 300ms and the 3rd media panel to opacity 1.
- `prefers-reduced-motion`: no auto-advance; bars full for the active step, Lotties on their last frame; clicking still switches.

**Mobile accordion (<1024):**
- `h2.h2-small mb-24` then 3 accordion items; first is open by default.
- Header button: `w-full text-left py-16`; row: h3.h3-small + chevron (16×10 `ChevronDownIcon`, 16px box, `ml-16`). Open = `rotate-180`; rotation transition 0.5s cubic-bezier(0,0,.2,1) → GSAP `rotation` 0.5s `EASE.qontoOut`. Description `body-regular mt-16` is always visible.
- Panel (`accordion-menu`): height animates 0 ↔ content (GSAP `height: "auto"`, 0.3s `EASE.cssOut`), overflow hidden while closed. Content: `-mx-16 my-16 flex justify-center` → 343×343 rounded-2xl box with the gradient image + Lottie (`mode="loop"`).
- Opening one closes the others.
- CTA "Discover Qonto AI" below (`mt-32`).

## Per-State Content
| Step | Title | Body | Lottie |
|---|---|---|---|
| 1 | Agents, inside Qonto | Ask Agents directly inside Qonto, right within the workflows you already use. | `lottieUrl("40500")` (9s, "The Operator" chat: "Pay salaries to my employees" / payroll CSV drop) |
| 2 | MCP, in your AI tools | Connect Qonto MCP to the AI tools you already work with every day. | `lottieUrl("40501")` (7.5s) |
| 3 | Visibility & accountability | AI drafts the work, you review & approve. All actions logged and traceable. | `lottieUrl("40502")` (7.5s) |

## Assets
- Gradient backdrop: `staticUrl("wr_topic_highlight_advanced/ai_gradient_background.png")` (2960×2960), `absolute inset-0 w-full h-full object-cover pointer-events-none`, alt "".
- Lotties 40500/40501/40502 (540×540 each, 60fps; render at full box size).

## Text Content (verbatim)
- "Qonto AI." / "Your choice, your control."
- Step copy in the table above.
- CTA "Discover Qonto AI" → https://qonto.com/en/ai

## Responsive Behavior
- Desktop block `hidden lg:block`; accordion block `lg:hidden`.
- 768: accordion with `md:px-32`, h2 40/48, h3 24/32, body 18/28 (see `raw/ai-768.txt`).
