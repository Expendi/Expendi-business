# Qonto clone verification

Continuation of Claude session `b8aa6497-a38e-41ba-b8fb-87e34d35a3a7`, performed locally in OpenCode on 2026-11-03 with the user's approval. Branch: `claude/marketing-qonto-clone`.

## Reference and coverage

The live https://qonto.com/en page was accessible in Playwright Chromium. Fresh captures were taken at **1440×900**, **768×1024**, and **390×844**, alongside the session's preserved original screenshots and computed-style dumps. Cookie notices are dismissed when shown. Section captures attempt to hide fixed navigation/chat/CTA overlays; this succeeds on the clone, but some live mobile captures retain chat/CTA overlays. Full-page captures retain overlays. These images support visual review, not clean pixel-zero comparisons.

The existing implementation contains 11 main sections (company copy and its media occupy separate sections), the footer, header, country pickers, cookie consent, chatbot launcher, and mobile CTA. All 197 asset-manifest entries exist locally (37.39 MiB): 130 AVIFs, 18 PNGs, 17 SVGs, 11 JPEGs, 8 videos, 9 JSON files and 4 fonts. The 11 component specifications and raw extraction records remain in `components/` and `raw/`.

## Layout comparison

Every main section's top and height matches the **original extracted reference** at all three widths. This also matched fresh live measurements during the first QA passes. Later, Qonto began serving a different AI section; that discrepancy is recorded below rather than silently replacing the original design. `qa:geometry` checks the original raw measurements, including available heading positions and typography, with 1 CSS pixel of rounding tolerance. Image, font, copy, card, color and background treatments were visually compared using the per-section captures.

| Section                | Desktop                                                | Tablet                                                    | Mobile                                                    |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| Hero                   | Matched                                                | Matched                                                   | Matched                                                   |
| Trust items            | Matched                                                | Matched                                                   | Matched                                                   |
| Business-account bento | Matched                                                | Matched                                                   | Matched                                                   |
| Qonto AI               | Original layout preserved; latest live variant differs | Original accordion preserved; latest live variant differs | Original accordion preserved; latest live variant differs |
| Invoicing              | Matched layout; hover media                            | Matched layout; carousel                                  | Matched layout; carousel                                  |
| Integrations           | Matched layout; rotating media                         | Matched layout; rotating media                            | Matched layout; rotating media                            |
| Company creation       | Matched                                                | Matched                                                   | Matched                                                   |
| Company media          | Matched                                                | Matched                                                   | Hidden, matching live page                                |
| Testimonials           | Matched layout; slide-dependent imagery                | Matched layout; slide-dependent imagery                   | Matched layout; slide-dependent imagery                   |
| Protection             | Matched; animated border                               | Matched; animated border                                  | Matched; animated border                                  |
| Closing CTA            | Matched                                                | Matched                                                   | Matched                                                   |
| Footer                 | Matched content/layout                                 | Matched content/layout; auto-height wrapper               | Matched content/layout; auto-height wrapper               |

### Reference details clarified during verification

- **Live AI discrepancy:** the original section heights are 900/983/1053px at 1440/768/390; the later server-rendered `simple_stepper` variant measures 820/1336/922px, with different heading sizes and media arrangements. The original `wr-tha` design remains implemented. Latest live captures therefore show downstream vertical offsets caused by this one changed section. [Provenance and measured differences](INTERACTION_QA.md) establish the change, but do not prove whether it was a deployment, CMS publication, or experiment.
- Qonto's small-screen footer white wrapper has a fixed height (`305px` at 768px, `370px` at 390px) and its legal text overflows that wrapper. The clone deliberately contains that same content in an auto-height wrapper. Compare the complete document height and full footer content, not just the footer element's bounding box.
- Contrary to the earlier company-media specification, the live mobile `section-8` is hidden (zero height), matching the implementation. There is no extra square spacer.
- Lottie/video frames and the rotating protection border vary with capture timing. A raw full-page pixel difference is not a zero-difference acceptance criterion for these moving regions.
- Lazy images in inactive slides/closed accordions are not broken assets. The capture diagnostic distinguishes unloaded images from completed, failed image requests.
- `../design-references/qa/comparison-*.jpg` boards pair the latest live captures (left) with the original-design clone (right). Their AI row deliberately shows different designs; mobile overlay and animation-frame differences remain visible. The original AI images remain outside `qa/` as `section-ai-{1440,390}.jpg`.

## Final verification results

Production browser checks ran against `http://localhost:3004` after a successful Next.js production build:

| Check                              | Result                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| Navigation and consent             | 46/46 checks passed; zero browser runtime errors                  |
| Interactive sections               | All six viewport/motion combinations passed                       |
| Chatbot and floating CTA           | All four viewport/motion combinations passed                      |
| Motion                             | Normal and reduced-motion checks passed                           |
| Original-reference geometry        | All three widths passed, including 27 measured headings per width |
| Production build                   | Passed; existing `metadataBase` fallback warning                  |
| Package-wide TypeScript and ESLint | Passed                                                            |
| `git diff --check`                 | Passed                                                            |

The final production navigation rerun also verifies immediate drawer hiding under reduced motion. A zero-duration GSAP timeline previously deferred visibility until the next tick; the drawer now sets its final state synchronously.

## Reproducing the checks

From `apps/marketing`, run a dev or production server, then:

```sh
pnpm qa:visual
pnpm qa:geometry
pnpm qa:motion
pnpm qa:interactions
pnpm qa:navigation
pnpm qa:overlays
```

`QA_BASE_URL` overrides `http://localhost:3003`. `QA_TARGET=reference` or `QA_TARGET=clone` limits visual capture to one target. Visual screenshots and computed geometry are saved in `docs/design-references/qa/`. The default geometry check compares clone captures against the original `raw/*.txt` and `PAGE_TOPOLOGY.md` measurements. `QA_REFERENCE=live pnpm qa:geometry` instead compares with the latest live captures and currently detects the documented AI redesign. Playwright's Chromium must be installed (`pnpm exec playwright install chromium`).

`qa:motion` checks normal and reduced-motion hero behavior, visible protection rotation, offscreen pausing, and static/animated integrations frames. The browser suites exercise UI controls without following signup/payment links or contacting a real support backend.

## Fixes completed

- Chatbot reveal after the hero, mobile CTA-aware launcher/panel offsets, footer CTA dismissal, delayed help tooltip and unread badge, local restart, exact measured spring curve, and reduced-motion behavior.
- Off-screen mobile navigation, interrupted drawer transitions, breakpoint state resets, and desktop mega-menu clipping at 1024px.
- Custom cookie-purpose choices now survive saving and reloading.
- Live reduced-motion changes now stop AI/Lottie playback, cancelled swipes snap back, and vertical invoice-card drags no longer navigate accidentally.
- Testimonials start at slide 0 and use the measured 6-second autoplay, hover pause, interaction stop and last-slide stop. Earlier “no autoplay” research was corrected.
- Footer rating heading semantics match the source.
- Six repeatable QA commands and source/clone screenshot evidence were added.

## Scope and known limits

- The current live AI redesign is not implemented; the original session's reference design is preserved.
- Chatbot conversation remains a local loading-state demonstration. “Start again” restarts that local state. No remote support or signup backend is connected.
- Cookie preferences reproduce the captured simplified interface, not Didomi's full vendor-management system.
- Validation used Chromium. Safari and Firefox were not independently tested.
- Build succeeds with Next.js's existing `metadataBase` fallback warning for social-image URLs; this local reference clone is not configured for a deployment hostname.

Detailed interaction and navigation evidence: [INTERACTION_QA.md](INTERACTION_QA.md), [QA_NAVIGATION.md](QA_NAVIGATION.md), and `../design-references/qa-navigation/results.json`.
