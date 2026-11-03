# Interaction QA — 2026-11-03

## Baseline and live-source discrepancy

The implementation retains the originally extracted AI design described in
`components/qonto-ai.spec.md`, `raw/ai-{1440,768,390}.txt`, and the preserved
`../design-references/section-ai-{1440,390}.jpg` images.

During this QA session, the live `https://qonto.com/en` AI section changed:

| Observation            | Original extraction                                          | Later live response            |
| ---------------------- | ------------------------------------------------------------ | ------------------------------ |
| Controller             | `wr-tha` desktop; `accordion` mobile                         | `simple-stepper-assets`        |
| Section type           | Topic highlight with desktop progress steps/mobile accordion | `data-q-type="simple_stepper"` |
| Desktop heading        | `h2-small`, 40px/48px                                        | 56px/64px at 1440px            |
| Mobile heading         | 28px/36px                                                    | 24px/32px at 390px             |
| Section height, 1440px | 900px                                                        | 820px                          |
| Section height, 768px  | 983px                                                        | 1336px                         |
| Section height, 390px  | 1053px                                                       | 922px                          |

Provenance of the later observation:

- Installed Playwright Chromium, fresh browser contexts at 1440, 768, and 390px.
- The responses shared ETag `W/"680b052a41156836793ff0184d753051"`.
- Browser response `Date`: `Tue, 03 Nov 2026 11:42:47 GMT`; CloudFront cache hits,
  with `Age` 218–229 seconds across the three captures.
- Independent cookie-free Node HTTP requests to `/en`,
  `/en?qa_reference=20261103`, and `/en/` returned the same ETag. The trailing
  slash redirected to `/en`; the query did not select the original markup.
- Raw server HTML already contained `data-controller='simple-stepper-assets'`,
  `data-q-type='simple_stepper'`, and `data-q-id='4315607'`. It did not contain
  the original `data-controller="wr-tha"` markup.

**The cause is unproven.** These observations establish changed server-rendered
content, but do not establish whether it was a deployment, a CMS publication,
or server-side experimentation. No original-variant selector was identified.
The current `../design-references/qa/reference-*.json` captures represent the
later variant and should not be treated as geometry failures of the original
AI baseline. No AI redesign was made.

## Testimonial correction to the original research

The original testimonial spec and `BEHAVIORS.md` describe no autoplay and an
initial index of 2. Direct live inspection disproved those assumptions:

- Six fresh loads (three at 1440px, three at 390px) had Swiper `initialSlide: 0`
  and active index 0.
- Swiper configuration: `autoplay.enabled: true`, `delay: 6000`,
  `waitForTransition: true`, `disableOnInteraction: true`,
  `stopOnLastSlide: true`, `pauseOnMouseEnter: true`.
- A separate off-screen observation recorded index 0 → 1 → 2 as time passed.

Different testimonial screenshots therefore do not establish random initial
selection. The implementation now starts at 0 and follows that measured
autoplay behavior, while disabling autoplay for reduced motion.

## Behavioral fixes and reproduction

- Changing reduced motion while AI was playing previously left its timer
  running: the bar advanced from 18.41% to 27.30% after the preference changed.
  The AI timer and Lottie playback now respond to preference changes; Lottie
  effects revert their previous triggers/listeners before reconfiguration.
- A cancelled testimonial drag previously advanced index 0 → 1. Both carousels
  now snap back on `pointercancel`.
- Vertical mouse dragging over an invoice card could follow its link. Dragged
  gestures now suppress that subsequent click.
- New animation work is scoped to `useGSAP`, with media-query and event-listener
  cleanup.

Run against the existing local server:

```sh
node scripts/qa-interactions.mjs
```

Optional environment variables: `QA_BASE_URL` (default
`http://localhost:3003`) and `QA_WIDTHS` (default `1440,768,390`). The script
blocks external document navigation and checks browser runtime errors.

Verified normal and reduced-motion cases at 1440, 768, and 390px: every AI
step/accordion, AI wraparound, invoice hover/playback, carousel arrows and
boundaries, mouse drags, native touch swipes, cancelled gestures, testimonial
autoplay/hover pause/interaction stop, and live reduced-motion changes.
