# Page overlays spec (cookie banner, mobile CTA bar, chatbot launcher)

## Overview
- Targets (all `'use client'`):
  - `src/components/layout/cookie-banner.tsx` → `export function CookieBanner()`
  - `src/components/layout/mobile-cta-bar.tsx` → `export function MobileCtaBar()`
  - `src/components/layout/chatbot-launcher.tsx` → `export function ChatbotLauncher()`
- Screenshots: `cookie-banner-1440.jpg`, `state-cookie-390.jpg`, `state-cookie-find-out-more.jpg`, `state-mobile-aside.jpg` (launcher bottom-right)
- Raw: `raw/cookie-{1440,390}.txt`, `raw/chrome-log.txt` (COOKIE HOVER rows), `raw/aside-{1440,768,390}.txt`, `raw/chatbot-{1440,768,390}.txt`, "MOBILE ASIDE+HEADER" in `raw/timing-and-mobile.txt`

## 1. Cookie banner (Didomi notice popup)
Interaction model: **time + click**. Shown on first visit; dismissed by "Continue without agreeing →", "Accept" (both close it) or "Find out more" (Qonto opens a preferences screen — render a simplified preferences view with the same frame, or just keep the notice; closing must work). Persist the choice in `localStorage` key `qonto-clone-consent` (wrap access in try/catch that falls back to showing the banner; never an empty catch).
```
div backdrop: fixed inset-0, bg rgba(29,29,27,0.5), z 2147483641, flex, overflow auto
  div exterior border: margin auto (centred: 486,217 at 1440×900), padding 1px, radius 5px
    div dialog: 464×463 (1440), bg #fff, radius 8px, padding 32px, flex column items-center, border 1px transparent
      span "Continue without agreeing →" absolute top 20px right 20px, 15px/24px w400, colour rgb(99,99,96), underline, cursor pointer; hover opacity 0.7
      img logo: QontoWordmark-style logo 200×57 (Qonto uses https://qonto-assets…/logo_qonto_2022.jpg — render `QontoWordmark` at 200×57 in #1d1d1b instead), margin-bottom 30px
      div text (mt 16, max-w 600): 
        div title "Your data. Your choice." 20px/24px w400, mb 16
        p 16px/24px w300 colour #000, with link "right here" (16px/24px w700, rgb(5,5,5), underline) → https://qonto.com/en/cookies
      div buttons (mt 30, flex justify-between, 398 wide):
        "Find out more" 200×48, 16px/30px w700 ls 0.16px, colour rgb(68,68,68), bg transparent, border 1px solid rgb(29,29,27), radius 4px, padding 8px 16px, mr 10; hover opacity 0.7
        "Accept" 200×48, 16px/22.4px w700 ls 0.16px, colour #fff, bg rgb(29,29,27), border 1px solid rgba(29,29,27,0.3), radius 4px, padding 2px 25px; hover opacity 0.7 (Didomi `.didomi-components-button:hover{opacity:.7}`)
```
- 390: dialog full width minus 2px margins (x=2..388), padding 32px; text is justified; buttons stack full width (Find out more on top, 8px gap) — see `state-cookie-390.jpg` and `raw/cookie-390.txt`.
- Motion (GSAP): backdrop fades in 0→1 (0.3s `EASE.cssOut`) and the dialog rises from y 20 → 0 with opacity 0→1 (0.3s) on mount after a 0.5s delay; on dismiss reverse (0.2s) then unmount. Lock page scroll while open (`overflow: hidden` on `html`).
- Text verbatim: "Continue without agreeing →" · "Your data. Your choice." · "Like many websites, we use cookies. They allow us to follow your interactions on our site and this data helps us to personalize your experience while you're here. For example, we might use your data to display personalized ads. By clicking "Accept", you are giving us your consent to use cookies in this way. You can change your cookie settings at any time and can read our full cookie policy " + link "right here" + "." · buttons "Find out more", "Accept".
- Fonts: Didomi uses the page font (QontoSans) at the sizes above.

## 2. Mobile CTA bar (`<768` only, `md:hidden`)
Interaction model: **scroll**.
```
aside fixed bottom-0 inset-x-0 px-16 z-1000, height 72, backdrop-filter blur(5px)
  bg: rgba(5,5,5,0.7) over dark sections / rgba(255,255,255,0.7) over light sections (follows `data-header-theme`, probe at the bar's top, i.e. viewport bottom − 72)
  a.btn.btn-primary block text-center text-16 leading-24 my-12, 358×48, radius 8, padding 12px 16px: "Open an account" → https://welcome.qonto.com/signup/select-country
    colours: dark → bg #fff text rgb(5,5,5); light → bg rgb(5,5,5) text #fff
```
- Hidden state: `opacity 0; translateY(100%); pointer-events none`. Shown once scrollY passes the hero (measured: hidden at y=0, shown at y=300 on a 844px-tall viewport; use "hero bottom above viewport bottom − 72" or simply `scrollY > 200`). Transition 0.6s `EASE.qonto` (Qonto `duration-[600ms] ease-in-out`).
- Hide again when the footer's bottom block enters the viewport (optional; not measured).

## 3. Chatbot launcher (all breakpoints)
Interaction model: **click**.
```
button fixed right-16 bottom-36, 56×56, radius full, bg rgb(26,26,26), shadow 1px 0 10px 2px rgba(0,0,0,0.1), z 10001
  img staticUrl("chatbot/qonto_chatbot.png") 56×56 round, border 2px solid #fff
```
- Click toggles a panel: fixed right-16 bottom-108, width 360 (max calc(100vw-32px)), min-h 142, max-h 500, bg #fff, radius 6px, same shadow, z 10000. Header bar (absolute top, bg rgb(26,26,26), text #fff, padding 8px 15px, radius 6px 6px 0 0): avatar 32×32 with green online dot (bg rgb(69,177,132), 2px white border, bottom-right) + "Qonto" 14px/24px w600 ml-14; close `CloseIcon` 16 white on the right. Body (pt 56, px 16, pb 14): centred Lottie `staticUrl("decision_tree/qonto-flower-animate.json")` 46×46 looping (loading state).
- While open the launcher shows a close icon instead of the avatar (Qonto swaps to a dark 56px button with a 16px white X at top-16 left-16).
- Panel open/close animation: Qonto uses `transition: 0.3s cubic-bezier(0.73,-0.63,0.39,2.69)` on opacity/scale (springy). GSAP: from `opacity 0, scale 0.9, y 10, transformOrigin "bottom right"` to `1, 1, 0`, 0.3s with `CustomEase`-equivalent — use `ease: "back.out(2)"`.
- Hover: none recorded.

## Responsive Behavior
- Cookie banner: centred dialog ≥ 480px wide; full-width dialog at 390.
- Mobile CTA bar: only `<768`.
- Launcher: same position at all widths.
