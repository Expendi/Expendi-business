# Protection + closing CTA spec

## Overview
- Targets:
  - `src/components/sections/protection.tsx` → `export function Protection()` (Qonto renders it as a second `section#section-1` inside `div.col-span-12`; use id `section-protection`)
  - `src/components/sections/closing-cta.tsx` → `export function ClosingCta()` (`section#section-11`)
- Screenshots: `section-protection-{1440,390}.jpg`, `section-cta-{1440,390}.jpg`
- Raw: `raw/protection-{1440,768,390}.txt`, `raw/cta-{1440,768,390}.txt`
- Interaction models: Protection = **time** (rotating glow on the card border, infinite) + hover on the "Learn more" link (arrow swap). CTA = static (button hovers only).
- Themes: Protection dark (`data-header-theme="dark"`, `darkmode`). CTA: `data-header-theme="light"` (verified: qonto.com's header turns light over this photo section because its class is `surface-section-background-base`), but its content is white text on a dark photo → wrap the buttons in `darkmode`.

## Protection — DOM & styles
```
section bg rgb(5,5,5)
  div container grid 12 cols (90px), col-gap 24, padding 80px 48px (390: 48px 16px), max-w 1600
    left (lg col-span-5, flex-col justify-center)
      div.h2-small "First-class protection for your business." 40px/48px w600 (28/36 mobile), mb 24 (16 mobile, 12 md)
      a.btn-tertiary "Learn more" → https://qonto.com/en/trust : inline-flex items-center 18px/28px (16/26 mobile) #fff; ArrowSwap 18px up-right, ml-4, white glyph
    card (lg col-span-7; mt 24 / 32 md / 0 lg) 774×286 at 1440
      radius 24px (16 mobile); padding 48px (390: 24px 16px; md 32px 24px)
      border 1px solid transparent; box-shadow 0 0 20px 0 rgba(255,255,255,0.08)
      background-image: linear-gradient(rgb(26,26,26), rgb(26,26,26)) padding-box,
                        conic-gradient(from var(--gradient-angle), rgba(255,255,255,0) 0%, rgba(255,255,255,0.8) 8%, rgba(255,255,255,0) 18%, rgba(255,255,255,0) 100%) border-box
      inner: flex md:flex-row (column on mobile) justify-center lg:justify-end, gap 32px 56px, height 100%
        item ×3: flex-col justify-center, items-center text-center (mobile) / items-start text-left (md+)
          img h-64 md:h-80 w-auto object-contain, `filter: invert(1)`
          div.body-regular mt-24 > p  (18px/28px #fff; widths 174 / 155 / 236 at 1440 → natural wrap)
```
Items: (1) `QontoImage asset="34547"` alt "Cybersecurity Generic" 80×80 — "Legally protected customer funds"; (2) `asset="33291"` alt "Founds Regulatory ACPR" 80×80 — "Regulated financial institution" (wraps to 3 lines at 1440: item width 155); (3) `asset="34548"` alt "Cybersecurity RGPD ISO27001" 140×80 — "Top standards in IT security & data protection".
Item x positions at 1440: 667, 897, 1107 (gap-x 56); item 2 image is top-aligned 14px higher because its text is 3 lines (items are `justify-center` within 188px).

## Protection — behaviour
- **Rotating glow**: `--gradient-angle` animates 0deg → 360deg, 3s, linear, infinite (Qonto `@keyframes rotate-gradient`, `.gradient-border-auto`). Implement with GSAP: `gsap.to(card, { "--gradient-angle": "360deg", duration: 3, ease: "none", repeat: -1 })` with the CSS var initialised to `0deg` inline, and the background built from `var(--gradient-angle)`. Reduced motion: hold at 80deg (Qonto's `@property` initial value).
- **Learn more hover**: Qonto adds `.arrow-animate` → `arrow-exit` .3s cubic-bezier(.4,0,.6,1) and `arrow-enter` .3s with .15s delay → `ArrowSwap duration={0.3} enterDelay={0.15}` with the link as trigger. Click pulse (`tertiary-click-pulse` scale 1→0.9→1, 0.3s) on `:active` → GSAP on pointerdown.

## Closing CTA — DOM & styles
```
section#section-11 relative overflow-hidden, 1440×664 (390: 814)
  bg layer: absolute inset-0 bg-cover bg-center, image: <768 /qonto/asset/35028/md.avif; 768–1023 /qonto/asset/35028/lg.avif; ≥1024 /qonto/asset/35029/xl.avif
  blur layer: same image + photo-blur-top-to-bottom (<lg) / lg:photo-blur-left-to-right
  scrim: scrim-dark-top-to-bottom (<lg) / lg:scrim-dark-left-to-right
  container grid 12 cols, padding 80px 48px (390: 48px 16px), max-w 1600
    wrapper (lg grid 12 cols, rows 128/44/100, content-center, min-h 504, padding 64px 0; mobile: flex-col items-center px-24 pt-32 text-center)
      h2 (z-10, col-span-6, lg:pl-64) 56px/64px w600 #fff: "Complicated?" + <p>"Not with Qonto."</p> (block)  → mobile 32/40 centred
      div.body-regular (col-span-5, mt-16 (12 mobile), lg:pl-64) 18px/28px #fff > p
      div buttons (col-span-5, mt-48 (32 mobile), lg:pl-64, flex lg:flex-row items-center gap-16) > div.darkmode.flex.flex-wrap.gap-16 justify-center lg:justify-start → primary "Open an account" (175×52) + secondary "Find the right plan" (185×52)
```
Text x at 1440: 112 (48 container + 64 pl). h2 top 7581 relative to section top 7385 → 196px.

## States & Behaviors (CTA)
Buttons: hover colours from `.darkmode .btn-*` (instant). No other motion.

## Text Content (verbatim)
- Protection: "First-class protection for your business." · "Learn more" · "Legally protected customer funds" · "Regulated financial institution" · "Top standards in IT security & data protection"
- CTA: "Complicated?" / "Not with Qonto." · "Open your business account in just 10 minutes." · "Open an account" → https://welcome.qonto.com/signup/select-country · "Find the right plan" → https://qonto.com/en/pricing

## Responsive Behavior
- Protection `<1024`: stacked; card full width, items stacked vertically and centred (gap-y 32), images 64px tall (80 md).
- CTA `<1024`: centred column, background uses the md/lg crops, top-to-bottom scrim.
