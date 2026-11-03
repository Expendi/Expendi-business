# @expendi-business/marketing

A **design-reference clone of [qonto.com/en](https://qonto.com/en)**, built to study layout, typography, motion and responsive behaviour for the future Expendi Business marketing site. It is **not** an Expendi Business site and must not be deployed as-is: almost everything visible on the page is Qonto's intellectual property (see [Third-party assets](#third-party-assets-to-replace-before-deployment)).

Stack: Next.js 16 (App Router), React 19.1, Tailwind CSS 4, GSAP 3 (`@gsap/react`, ScrollTrigger, CustomEase) and lottie-web. Same scripts and shared tooling as `apps/web`.

## Commands

```bash
pnpm --filter @expendi-business/marketing dev        # http://localhost:3003
pnpm --filter @expendi-business/marketing build
pnpm --filter @expendi-business/marketing start      # serves the production build on :3003
pnpm --filter @expendi-business/marketing typecheck
pnpm --filter @expendi-business/marketing lint
pnpm --filter @expendi-business/marketing qa:visual       # live reference + local screenshots
pnpm --filter @expendi-business/marketing qa:geometry     # compare captured layout measurements
pnpm --filter @expendi-business/marketing qa:motion
pnpm --filter @expendi-business/marketing qa:interactions
pnpm --filter @expendi-business/marketing qa:navigation
pnpm --filter @expendi-business/marketing qa:overlays
pnpm --filter @expendi-business/marketing download-assets   # re-mirrors public/qonto from asset-manifest.json
```

## Layout

| Path                          | Contents                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`                    | `layout.tsx` (QontoSans via `next/font/local`, metadata), `page.tsx` (section assembly), `globals.css` (tokens, type scale, button themes, scrims) |
| `src/components/sections/`    | One file per page section, top to bottom                                                                                                           |
| `src/components/layout/`      | Header, footer, cookie banner, mobile CTA bar, chatbot launcher                                                                                    |
| `src/components/ui/`          | Shared primitives: `ButtonLink`, `QontoImage`, `Lottie`, `ArrowSwap`                                                                               |
| `src/components/icons.tsx`    | The 52 unique inline SVGs from the page, generated from the live DOM                                                                               |
| `src/content/navigation.ts`   | Mega-menu, country and footer link data (verbatim)                                                                                                 |
| `src/lib/`                    | GSAP setup + Qonto easing curves, asset registry/URL helpers, section-theme hook                                                                   |
| `public/qonto/`               | Mirrored assets (images, videos, Lottie JSON, fonts, favicons)                                                                                     |
| `scripts/download-assets.mjs` | Mirrors every URL in `scripts/asset-manifest.json` (4 parallel downloads, retries)                                                                 |
| `docs/research/`              | `PAGE_TOPOLOGY.md`, `BEHAVIORS.md`, per-component specs, raw computed-style dumps                                                                  |
| `docs/design-references/`     | Reference screenshots of qonto.com (full page, sections, interaction states)                                                                       |

Tailwind uses Qonto's `--spacing: 1px` scale, so `p-24` is 24px. Every value in the specs comes from `getComputedStyle` on the live site.

See [QA results and reproduction](docs/research/QA.md) for browser coverage, comparison captures, and known differences. Browser checks require a running server and Playwright Chromium. Set `QA_BASE_URL` to test another local port.

## Third-party assets to replace before deployment

Everything below belongs to Qonto SA or to third parties and was mirrored only as a local design reference. **Replace each category with Expendi Business material (or properly licensed equivalents) before anything built from this app is deployed or published.**

| Category                                                                                                                                                                                         | Where                                                                                                                                                               | Owner / licence status                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Typeface: QontoSans** (light, regular, semibold, bold `.woff2`)                                                                                                                                | `public/qonto/static/qontosans-*.woff2`, loaded in `src/app/layout.tsx`                                                                                             | Qonto's proprietary brand typeface. No licence is granted for reuse. Swap for the Expendi brand font (apps/web uses Outfit, OFL-licensed).                                             |
| **Qonto logos and wordmark**                                                                                                                                                                     | `QontoLogo`, `QontoWordmark` in `icons.tsx`; cookie-banner logo; favicon, apple-touch-icon, Safari pinned tab, OG image in `public/seo/` and `public/qonto/static/` | Qonto trademarks.                                                                                                                                                                      |
| **Product imagery and photography** (hero video + posters, bento photos, card and phone mock-ups, company-creation photo, closing-CTA photo, mega-menu highlight images, AI gradient backdrop)   | `public/qonto/asset/*`, `public/qonto/video/*`, `public/qonto/static/wr_topic_highlight_advanced/`                                                                  | Qonto's commissioned photography and product UI.                                                                                                                                       |
| **Lottie animations** (Pay prompt, Qonto AI steps, invoicing cards, integrations orbit, chatbot loader)                                                                                          | `public/qonto/asset/{34192,38018,40500,40501,40502,40503,40850}/file.json`, `public/qonto/static/decision_tree/`                                                    | Qonto product animations. The integrations orbit also contains third-party logos (Google Drive, Sage, Stripe, Amazon, Cegid, WhatsApp, ACD and others), each a trademark of its owner. |
| **Customer testimonials**: photos, names, quotes and company logos (Poiscaille, Ooak Data, Solarian, AS Projets)                                                                                 | `src/components/sections/testimonials.tsx`, assets 34488/34489/34566/34756, 25709/34545/34546                                                                       | Real people and companies; their consent was given to Qonto, not to Expendi.                                                                                                           |
| **Marketing copy and legal text** (headlines, feature copy, mega-menu labels, footer links, Qonto SA legal notices, cookie-consent text)                                                         | Every section file, `src/content/navigation.ts`, `site-footer`, `cookie-banner`                                                                                     | Qonto's copyright; legal notices describe Qonto SA's regulatory status and must never appear on an Expendi site.                                                                       |
| **Regulatory and security badges** (PSD2, BaFin, DSGVO/ISO 27001, ACPR, RGPD/ISO 27001, "Legally protected funds")                                                                               | assets 33288/33290/33292, 34547/33291/34548                                                                                                                         | Certification marks that state Qonto's licences; Expendi may not display them.                                                                                                         |
| **Third-party marks**: Trustpilot logo and star, App Store and Google Play badges, Apple/Google Play glyphs, Mastercard imagery, social-network icons (Facebook, X, LinkedIn, Instagram, Medium) | `public/qonto/static/trustpilot-logo-with-text-dark.svg`, assets 33597/33601/33596–33603, `icons.tsx`                                                               | Trademarks of Trustpilot, Apple, Google, Mastercard and the social networks; use only under each brand's guidelines with Expendi's own ratings/listings.                               |
| **Iconography** (mega-menu icon set, feature icons, country flags, arrows/chevrons)                                                                                                              | `icons.tsx`, assets 3564/24698/26498/26586/33263/34341                                                                                                              | Qonto's icon set; flags are generic but were drawn by Qonto. Replace with Expendi's icon library (apps/web uses lucide).                                                               |
| **Chatbot avatar**                                                                                                                                                                               | `public/qonto/static/chatbot/qonto_chatbot.png`                                                                                                                     | Qonto.                                                                                                                                                                                 |
| **Ratings and statistics** ("4.7", "750,000+ clients", "24/7 human support", "Earn up to 5%*")                                                                                                   | Hero, trust items, footer                                                                                                                                           | Qonto's claims; Expendi must use its own verified figures.                                                                                                                             |

Links throughout the clone still point to qonto.com, and the page is marked `noindex, nofollow`.

## Regenerating research

The extraction scripts used during reconnaissance (Playwright + `getComputedStyle`) are summarised in `docs/research/`. Re-run `pnpm download-assets` to restore `public/qonto/` if it is cleaned; add `--force` to refresh files.
