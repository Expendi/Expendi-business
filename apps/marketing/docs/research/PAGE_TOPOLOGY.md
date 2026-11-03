# qonto.com/en — page topology

Captured 2026-11-03 with headless Chromium 156 (Playwright 1.64), viewports 1440×900, 768×1024, 390×844, cookie banner dismissed via "Continue without agreeing". Document height: 9336 (1440), 12104 (768), 11046 (390).

## Layers (z-index, top → bottom)
| Layer | Element | Position | z-index |
|---|---|---|---|
| Cookie notice | `#didomi-popup` backdrop + dialog | fixed, full viewport | 2147483641 |
| Chatbot launcher / panel | `.chatbot-full-container` button (56×56, right 16, bottom 36) | fixed | 10001 / 10000 |
| Header | `header#nav-revamp` (80px lg / 64px) | fixed top | 100000 |
| Mega-menu overlay | `div.overlay` black, opacity 0 → 0.5 | fixed top-80 | -10 (inside header stacking context) |
| Mobile CTA bar | `body > aside` (72px) | fixed bottom, `<768` only | 1000 |
| Page flow | `main#website-main > #landing-page-sections` then `footer` | static flow | auto |

## Sections in order (1440 geometry)
| # | Qonto id | Clone component | Top | Height | Theme (`data-header-theme`) | Interaction model |
|---|---|---|---|---|---|---|
| 1 | `section-1` | `Hero` | 0 | 900 | dark | static + looping background video |
| 2 | `section-2` | `TrustItems` | 900 | 384 | dark | static |
| 3 | `section-3` | `Bento` | 1284 | 1120 | dark | in-view Lottie (Pay card, plays once) |
| 4 | `section-4` | `QontoAi` | 2404 | 900 | light | time-driven steps (9s / 7.5s / 7.5s) + click; accordion `<1024` |
| 5 | `section-5` | `InvoicingCards` | 3304 | 847 | light | hover (lift, arrow, Lottie) ≥1024; carousel `<1024` |
| 6 | `section-6` | `Integrations` | 4151 | 664 | light | scroll-gated looping Lottie |
| 7 | `section-7` | `CreateCompany` | 4815 | 448 | light | static |
| 8 | `section-8` | `CreateCompany` (media) | 5263 | 608 | light | static (image with baked-in UI overlays) |
| 9 | `section-9` | `Testimonials` | 5871 | 1068 | dark | click/drag slider (no autoplay); fade slider `<1024` |
| 10 | `section-1` (dup id) | `Protection` | 6939 | 446 | dark | infinite rotating border glow + link hover |
| 11 | `section-11` | `ClosingCta` | 7385 | 664 | light (class `surface-section-background-base` despite dark photo) | static |
| 12 | `footer` | `SiteFooter` | 8049 | 1287 (788 dark + 499 white) | dark / light | hover |

## Fixed vs flow
- Fixed: header, mobile CTA bar, chatbot launcher, cookie notice.
- Everything else is normal flow. No pinned/sticky sections, no scroll-snap, no smooth-scroll library (no `.lenis`/Locomotive classes; `html.scroll-smooth` only affects anchor jumps).

## Breakpoints
- `md` 768px and `lg` 1024px drive every layout change; `xl` 1280 / `2xl` 1536 are not used on this page. Container max-width 1600px with 16/32/48px side padding.
