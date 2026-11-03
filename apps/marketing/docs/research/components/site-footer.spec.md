# Site footer spec

## Overview
- Target: `src/components/layout/site-footer.tsx` → `export function SiteFooter()` (`'use client'` only for the link/arrow animations — split a small client child if you prefer)
- Screenshots: `section-footer-1440.jpg`, `section-footer-390.jpg`, bottom of `qonto-full-1440.jpg`
- Raw: `raw/footer-{1440,768,390}.txt`, footer rows of `raw/navdata.json`, "footer pricing card" / "footer link" in `raw/hover-and-header-states.txt`
- Data: `FOOTER_COLUMNS` from `~/content/navigation`
- Interaction model: **hover** (Pricing card arrow swap, link underline grow). Static otherwise.
- Themes: top block dark (`data-header-theme="dark"` + `darkmode`), bottom block white (`data-header-theme="dark"` too? No — verified header stays dark at y=8800 because the probe line sits over the dark block; mark the white block `data-header-theme="light"`).

## DOM Structure
```
footer
  div top (relative z-1, bg rgb(5,5,5), text #fff, padding 80px 48px | 64px 32px md | 40px 16px)
    div grid 12 cols (90px at 1440), col-gap 24 (8 mobile), max-w 1504, mx-auto
      left (col-span-12 lg:col-span-3, flex-col)
        Pricing card: a group, p-24, radius 24 (16 mobile), bg rgb(26,26,26) (grey-900), lg:w-2/3 (212×140)
          a.flex justify-between items-start gap-4: "Pricing" (h3-small-ish? computed 18px/24px → use text-18 leading-24? see raw: row 164×32) + round 32×32 bg rgb(61,61,61) with white ArrowSwap 18 (0.25s)
          div.caption pt-16 text rgb(204,204,204) 14/22 → p "Find the best plan for your business needs."
        ratings (my-24 lg / my-32): flex column gap-24 lg:px-16 (mobile: row, justify-center, gap 16)
          row ×3: [h3.h3-small "4.7" + StarIcon 20×20 white] [16×16 store icon + div.caption-slim "on App Store" (14/24 w300)]
            icons: AppleIcon (white), GooglePlayIcon (colour), TrustpilotStarIcon (green #00b67a)
      right (col-span-12 lg:col-span-9) CSS columns: 2 (mobile) / 3 (md+), column-gap 24
        group ×9 (mb 24 lg / 32, break-inside avoid):
          title div.body-small-bold 16/26 w700 #fff, pb 8 (16 mobile)  (14/22 on mobile)
          link rows div.caption pb-8 → a 14/22 rgb(204,204,204), padding-bottom 2px, underline-on-hover
  div bottom (relative z-10, bg #fff, text rgb(5,5,5), padding 40px 48px 0 (md pt-64))
    row (flex justify-between items-end, py-40 lg; mobile flex-col gap-y-40 pb-40)
      QontoWordmark 343×100 (fill rgb(29,29,27) → currentColor rgb(5,5,5)... use `text-[#1d1d1b]`)
      right group (flex md:flex-row gap 32/16, lg:justify-start):
        badges (flex gap-8 items-end): QontoImage 33290 (64×64, PSD2), 33292 (64×64, BaFin), 33288 (112×64, DSGVO/ISO) alt "Badge Asset"
        column (gap-y 24):
          socials (flex justify-end): 5 × div.px-6 > a 30×30 → QontoImage 33603 Facebook, 33596 X, 33598 LinkedIn, 33599 Instagram, 33600 Medium (h-30 w-auto)
          stores (flex gap-16 justify-end): QontoImage 33597 "App Store" h-40 (127×40), 33601 "Play Store" h-40 (134×40)
    hr border-t 1px rgb(204,204,204)
    row (flex justify-between items-center):
      links (inline-block caption-small 12/18, mt-32 mb-16, leading 32): 6 × a mr-16 with underline-on-hover (underline colour rgb(5,5,5))
      language (hidden md:block pt-8): button "EN" 18/24 w300 uppercase + caret 13×6 (pl-40 pt-24 pb-16); EuropeFlag 24px before it (see screenshot)
    legal (caption-small 12/18, pb-80 lg / 64 md / 40): 3 paragraphs separated by empty <p><br/></p> lines
```

## Computed Styles (1440 unless noted)
| Element | Value |
|---|---|
| top block | 1440×788, padding 80px 48px |
| Pricing card | 212×140, padding 24, radius 24, bg rgb(26,26,26); "Pricing" text 18px/24px #fff; arrow circle 32×32 bg rgb(61,61,61) at right |
| ratings | x=64 (lg px-16), rows 32px tall, gap 24; "4.7" 24px/32px w600 (20/28 mobile) |
| columns | start x=390, 3 columns × 318px, gap 24; group titles 16px/26px w700 uppercase text as written; links 14px/22px rgb(204,204,204), rows 30px tall (pb 8) |
| bottom block | padding 40px 48px 0; wordmark 343×100 at x=48 |
| hr | 1344 wide, 1px rgb(204,204,204) |
| bottom links | 12px/18px rgb(5,5,5), mr 16 |
| legal | 12px/18px rgb(5,5,5), full width, padding-bottom 80 |

## States & Behaviors
- **Pricing card hover** (`group`): `ArrowSwap` up-right 18px, duration 0.25, enterDelay 0.15, card as trigger.
- **Link underline** (`border-bottom-animation`): `background: linear-gradient(currentColor…) no-repeat; background-size: 0 1px; background-position: right 100%`. On hover → `background-size: 100% 1px; background-position: left 100%`, 0.2s ease-in-out (footer links). Animate with GSAP (`backgroundSize`, `backgroundPosition`, 0.2s `EASE.cssInOut`); on leave reverse (position flips to right so it retracts to the right). Note: on qonto.com the dark-block link underline colour is rgb(5,5,5) (invisible on black) — replicate by using `#050505` for both blocks.
- Language button: opens the same country list as the header picker (reuse `COUNTRIES`, simple popover above the button); caret rotates 180° 0.4s.
- Reduced motion: instant.

## Text Content (verbatim)
- "Pricing" · "Find the best plan for your business needs."
- Ratings: "4.7" "on App Store" · "4.7" "on Play Store" · "4.7" "on Trustpilot"
- Columns: from `FOOTER_COLUMNS` (BUSINESS ACCOUNT, BUSINESS CARDS, COMPANY CREATION, GET PAID, FINANCING, FINANCIAL TOOLS, RESOURCES, COMPANY, FOR DEVELOPERS).
- Bottom links: "Cookies" (https://qonto.com/en/cookies), "Legal Documents" (https://legal.qonto.com/en), "Privacy Policy" (https://legal.qonto.com/en#template-6uiwuhdde), "Security" (https://qonto.com/en/security), "AI at Qonto" (https://legal.qonto.com/#artificial-intelligence-at-qonto), "Status Page" (https://status.qonto.com/)
- Socials hrefs: Facebook https://www.facebook.com/getqonto, X https://www.facebook.com/getqonto (sic, as on qonto.com), LinkedIn https://www.linkedin.com/company/qonto, Instagram https://www.instagram.com/qonto, Medium https://medium.com/qonto-way. Stores: https://apps.apple.com/fr/app/qonto-business-finance-app/id1214811644?l=en-GB, https://play.google.com/store/apps/details?id=eu.qonto.qonto&hl=en
- Legal:
  1. "Qonto SA is a Société Anonyme under French law, registered at the Paris Trade Register (n° 819 489 626) having its headquarters at 6 Impasse Bonne Nouvelle, 75010 Paris, France."
  2. "Qonto SA is a licensed payment institution authorized by the French Autorité de Contrôle Prudentiel et de Résolution (ACPR), under the registration number 16958 granted on 21/06/2018."
  3. "The entirety of the funds collected from our customers is safeguarded in compliance with the relevant legislation. A part of these funds is either held by our partner banks, Crédit Mutuel Arkéa, Société Générale, Natixis or Rothschild Martin Maurel, or invested in qualified money market funds, with the corresponding fund units held by Société Générale. In the case of bankruptcy of one of these partner banks, the deposits are covered up to €100,000 per institution and per client by the Fonds de Garantie des Dépôts et de Résolution (FGDR). The remaining part of the funds is fully covered by two stand-alone guarantees, one granted by Crédit Agricole CIB, a subsidiary of Crédit Agricole S.A., the other by BNP Paribas."

## Responsive Behavior
- 390: top padding 40/16; Pricing card full width (358×116, radius 16); ratings in one row (3 × ~100px, justify-center, label under number); link columns 2 × 167px, titles 14/22 pb 16, groups mb 32; bottom block stacks (wordmark centred, badges/socials/stores centred), language hidden.
- 768: 3 columns, padding 64/32.
