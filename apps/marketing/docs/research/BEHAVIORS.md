# qonto.com/en — behaviours

Every entry was measured with Playwright (computed styles before/after the trigger, sampled timelines). Raw logs: `raw/hover-and-header-states.txt`, `raw/timing-and-mobile.txt`, `raw/chrome-log.txt`.

## Global
- **No scroll-reveal animations.** Before any scrolling, every element below the fold is already at opacity 1 / no transform (only intentionally hidden UI such as inactive tabs, round arrows and slider overlays are not at rest).
- **No smooth-scroll library.** `html.scroll-smooth` (CSS) only.
- **Button hovers are instant** (`transition: all 0s`): primary dark `#fff → rgba(255,255,255,.92)`, primary light `#050505 → rgba(29,29,27,.92)`, secondary dark `transparent → rgba(245,245,245,.08)`, secondary light `transparent → rgba(29,29,27,.08)`.

## Header
- Theme follows the section under the header's bottom edge (switch measured at scrollY 2324 = section-4 top 2404 − 80). Dark: `rgba(5,5,5,.7)`, white text, white logo, white CTA. Light: `rgba(255,255,255,.7)`, black text/logo/CTA. `backdrop-filter: blur(6px)`. Background transition `0.5s ease-out`. Never hides on scroll.
- Sign in hover: colour → rgb(97,97,97), instant.
- Mega menu (hover, ≥1024): bar turns solid white, other items `rgba(26,26,26,.7)` (0.2s), black overlay 0 → 0.5 (0.3s ease-out), panel at top 96px / left −32px (radius 32px, padding 32px). Item hover dims siblings to rgb(97,97,97) (0.2s). Highlight card arrow swaps on hover.
- Language picker: caret flips 180° (0.4s ease-out); 292px panel "Select your country".
- Mobile: hamburger → X, white bar with 1px grey border scaling in (350ms), drawer slides from the right (0.35s), categories open sub-panels with a back arrow sliding in (0.15s, 0.15s delay).

## Section behaviours
| Section | Trigger | State A → State B | Timing |
|---|---|---|---|
| Hero | load | video opacity 0 → 1 once playing (poster underneath) | 0.5s qonto ease |
| Bento Pay card | enters viewport | Lottie 38018 plays once (300f @60fps = 5s), holds last frame | — |
| Qonto AI (≥1024) | in view, time | step i active (opacity 1, others 0.4, 0.5s); bar height 0 → 100% linear; media crossfade (0.5s); Lottie restarts | 9s, 7.5s, 7.5s, loops |
| Qonto AI | click step | jumps to that step immediately | — |
| Qonto AI (<1024) | click header | accordion opens (0.3s ease-out), chevron rotates 180° (0.5s) | — |
| Invoicing card (≥1024) | hover | translate 0 → −10px (0.25s ease-out); round arrow opacity 0 → 1 (0.1s linear); arrow swap (0.25s + 0.15s delay); Lottie plays once | — |
| Invoicing (<1024) | swipe / arrows | slide change, arrow buttons disabled at ends (opacity .45) | ~0.3s |
| Integrations | in view | Lottie 34192 plays at 30fps, pauses off-screen; intro frames 0–70 | 20s cycle |
| Testimonials (≥1024) | arrow click / drag | track translate (0.5s `ease`), active opacity .5 → 1 (0.35s), overlay out 0.15s / in 0.35s (+0.15s) | no autoplay |
| Testimonials (<1024) | arrow / swipe | fade slider, content y 8 → 0 | 0.35s |
| Protection card | time | conic border glow rotates 0 → 360deg | 3s linear infinite |
| Learn more / Pricing card | hover | arrow swap (exit to +18,−18; twin enters from −18,+18) | 0.3s / 0.25s, 0.15s delay |
| Footer links | hover | 1px underline grows left → right (`background-size 0 → 100%`) | 0.2s ease-in-out |
| Cookie buttons | hover | opacity 1 → 0.7 | instant |
| Mobile CTA bar (<768) | scroll past hero | opacity 0 → 1, translateY(100%) → 0; palette follows section theme | 0.6s ease-in-out |

## Per-state content captured
- Qonto AI: 3 steps (titles, bodies, Lotties 40500/40501/40502) — `components/qonto-ai.spec.md`.
- Testimonials: 4 slides (photo, logo, quote, author) — `components/testimonials.spec.md`.
- Mega menus: 6 menus, 5 highlight cards — `src/content/navigation.ts` (generated from the live DOM).
