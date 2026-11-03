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

- Hidden state: `opacity 0; translateY(100%); pointer-events none`. Shown at `scrollY > 200` (live recheck: hidden at 199, visible at 201 on 390×844). Transition 0.6s `EASE.qonto` (Qonto `duration-[600ms] ease-in-out`). Include `padding-bottom: env(safe-area-inset-bottom)`.
- Hide again when the **footer itself** enters the viewport, not its last child. Rechecked live; the public `mobile_sticky_cta_controller` also uses `footer.getBoundingClientRect().top < viewportHeight`.
- `data-mobile-cta-visible` exposes the bar's target visibility to the chatbot. The chatbot observes this attribute and the bar's rendered size, with scoped teardown.

## 3. Chatbot launcher (all breakpoints)

Interaction model: **scroll + click**. Hidden while the first section intersects the viewport; appears immediately after its bottom crosses the viewport top. Remains visible at the document bottom. An open panel retains its close launcher when returning to the hero.

```
button fixed right-16 bottom-36, 56×56, radius full, bg rgb(26,26,26), shadow 1px 0 10px 2px rgba(0,0,0,0.1), z 10001
  img staticUrl("chatbot/qonto_chatbot.png") 56×56 round, border 2px solid #fff
```

- Click toggles a panel: fixed bottom-108, height 100%, min-h 142, max-h 500, bg #fff, radius 6px, same shadow, z 10000. Desktop: right-16, width 360. Mobile: right-0, full viewport width. Header bar (absolute top, bg rgb(26,26,26), text #fff, padding 8px 15px, radius 6px 6px 0 0): avatar 32×32 with green online dot (bg rgb(69,177,132), 2px white border, bottom-right) + "Qonto" 14px/24px w600 ml-14. Right control: **Start again**, 32×32 flex container aligned left, white `EditIcon` 20×20 (live SVG paths match the existing icon). In the clone it remounts the local loading Lottie without closing the panel; the launcher X and Escape close the panel. Body (pt 56, px 16, pb 14): centred Lottie `staticUrl("decision_tree/qonto-flower-animate.json")` 46×46 looping (loading state).
- While open the launcher shows a close icon instead of the avatar (Qonto swaps to a dark 56px button with a **24px** white X at top-16 left-16).
- Mobile with CTA visible: launcher bottom `80px + env(safe-area-inset-bottom)`, panel bottom `152px + env(safe-area-inset-bottom)`. With CTA hidden: 36px / 108px. Offset changes take 0.3s `EASE.qonto`; desktop always uses 36px / 108px.
- Panel open/close animation: Qonto uses `transition: 0.3s cubic-bezier(0.73,-0.63,0.39,2.69)` (confirmed in the live `.bounce-transition-chatbot` CSS rule). GSAP: from `opacity 0, scale 0.9, y 10, transformOrigin "bottom right"` to `1, 1, 0`, 0.3s using `CustomEase.create("qontoChatbot", "0.73,-0.63,0.39,2.69")` for both directions.
- Hover: none recorded.

### Delayed help tooltip

- After **30,000ms** with the launcher visible and chat closed: show "👋 Hello! Need help?" plus a red unread badge "1". Returning to the hero cancels a pending timer; leaving starts a fresh timer. An already-shown, undismissed tooltip hides over the hero and returns immediately when leaving. Dismissal or opening chat after the hint has appeared suppresses it for the rest of the component's lifetime. Timer and animations clean up on unmount.
- Tooltip: fixed right 100px, bottom 40px, max-width 300px, padding 12px 16px, white background, radius 6px, same shadow as launcher. Text: 16px/24px, weight 500, rgb(26,26,26). Live measured size: **182.53125×48px** at both viewport widths.
- Pointer: absolute right −8px, bottom −2px, translateY(−100%), zero-size triangle with transparent 8px top/bottom borders and white 8px left border.
- Dismiss control: absolute left −24px, top 0, 20×20, circular, 1px white border, rgb(97,97,97), white 8px `CloseIcon`; accessible label "Dismiss chat help".
- Badge: fixed right 16px, bottom 76px, 16×16 circular, rgb(249,86,86), white 12px/24px weight 700 text; decorative to assistive technology. With mobile CTA visible, tooltip/badge bottoms are **84px / 120px plus safe-area padding** (live controller positions: 76+8 / 112+8).
- Entrance: opacity 0→1, y 20→0, scale .9→1 in 0.3s, measured `cubic-bezier(.34,1.56,.64,1)` registered with `CustomEase`. Dismissal: scale→.8 and opacity→0 in 0.3s CSS ease-out; badge fades out. Reduced motion uses zero-duration tweens while retaining the 30-second delay.

## Responsive Behavior

- Cookie banner: centred dialog ≥ 480px wide; full-width dialog at 390.
- Mobile CTA bar: only `<768`.
- Launcher: mobile position follows CTA visibility as above; both components skip tween durations with reduced motion, and the loader stays static.

## Live recheck (2026-11-03)

- Playwright Chromium, 1440×900 and 390×844, https://qonto.com/en. Desktop launcher at (1368,808), 56×56; open panel at (1064,292), 360×500. Mobile with CTA visible: launcher at (318,708), 56×56; open panel at (0,192), 390×500; CTA at (0,772), 390×72. At the page bottom the CTA hides and mobile launcher returns to (318,752).
- Confirmed source: public `controllers/front/chatbot_controller-79494e24acd00fe970a078eb007f79d99c0a2399c974e17d23b82f2c5de72c05.js` and `controllers/front/mobile_sticky_cta_controller-cb0c65a1b3d69b5e3a88ede27d70b547415723a2fca2e3dd9b6cb00e024eb357.js` under `https://qonto.com/blog/assets/`.
- Known fidelity limit: clone retains the loading-state chatbot rather than the remote conversation endpoint; "Start again" restarts that local loader.

## Reproducible overlay QA

Run `node scripts/qa-overlays.mjs` from `apps/marketing` with the development server running. Set `QA_BASE_URL` to override `http://localhost:3003`. The script uses Playwright Chromium at 1440×900 and 390×844 with both motion preferences, virtual time for the 30-second hint, and strict JSDoc types compatible with the project's `checkJs` setting.

Checks cover hero and 200px thresholds, mobile offsets, footer-entry dismissal, page-bottom persistence, palette changes, resize, tooltip timer cancellation/return/dismissal, unread badge styles, panel dimensions, Start again replacing the loader, Escape, reduced-motion static loader, and browser runtime errors. Each successful viewport/motion combination prints a JSON result; any failure exits nonzero.
