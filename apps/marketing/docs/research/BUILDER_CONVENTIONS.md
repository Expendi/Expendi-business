# Builder conventions (apps/marketing)

Every section builder works from its spec in `docs/research/components/` and these shared rules.

## Paths
- App root: `apps/marketing` (workspace `@expendi-business/marketing`). Sections live in `src/components/sections/<kebab-name>.tsx`.
- Do not edit `src/app/*`, `src/lib/*`, `src/components/ui/*`, `src/components/icons.tsx`, `src/app/globals.css`, `package.json`, or another builder's files. Report needed shared changes instead.

## Tailwind (v4, `--spacing: 1px`)
- Numeric utilities are pixels: `p-24` = 24px, `gap-16`, `mt-48`, `size-56`, `leading-28`, `w-[506px]` for non-integers.
- Radius: `rounded-lg` 8px, `rounded-xl` 12px, `rounded-2xl` 16px, `rounded-3xl` 24px, `rounded-full`.
- Breakpoints: `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px.
- Colours: `primary-black` #050505, `primary-white` #fff, `grey-25` #f9f9f9, `grey-50` #f5f5f5, `grey-100` #e8e8e8, `grey-200` #e0e0e0, `grey-300` #ccc, `grey-400` #b8b8b8, `grey-500` #8f8f8f, `grey-600` #616161, `grey-700` #3d3d3d, `grey-800` #262626, `grey-850` #2c2c2c, `grey-900` #1a1a1a, `trustpilot` #00b67a. Anything else: arbitrary value (`text-[rgb(204,204,204)]` = grey-300 etc.).
- Font sizes: `text-12 … text-72` tokens (12,14,16,18,20,22,24,28,32,40,44,56,72 px).
- Type utilities (mobile value, then ≥768px): `h2-small` 28/36→40/48 w600, `h3-small` 20/28→24/32 w600, `body-regular` 16/26→18/28, `body-bold`, `body-small-regular` 14/22→16/26, `body-small-bold`, `caption` 14/20→14/22, `caption-small` 12/18, `caption-slim` 14/24 w300, `lead` 18/28→22/32. Tag defaults: `h1` 44/52→72/80 w700, `h2` 32/40→56/64 w600, `h3` 24/32→28/36 w600 (override when the spec differs).
- Layout: `container-qonto` = max-width 1600px, centred, padding-inline 16/32/48 (base/md/lg).
- Photo/scrim utilities: `scrim-dark-photo-overlay-gradient`, `scrim-dark-top-to-bottom`, `scrim-dark-left-to-right`, `photo-blur-top-to-bottom`, `photo-blur-left-to-right`, `surface-container-gradient-light|dark|subtle`.

## Shared components
- `ButtonLink` (`~/components/ui/button`): `href`, `variant="primary"|"secondary"`, `className`. Colours flip inside any ancestor with class `darkmode`; hover colours are instant (as on Qonto).
- `QontoImage` (`~/components/ui/qonto-image`): `asset="<id>"`, `alt`, `sizes`, `priority`, plus img props. Works for AVIF sets and single-file assets (SVG/PNG) alike.
- `Lottie` (`~/components/ui/lottie`): `src={lottieUrl("<id>")}`, `mode="loop"|"inview-once"|"hover"|"manual"`, `hoverRef`, `segment`, `preserveAspectRatio`, `onReady(animation)`, `className`.
- `ArrowSwap` (`~/components/ui/arrow-swap`): Qonto's arrow micro-interaction; `triggerRef`, `direction="up-right"|"right"|"left"`, `size`, `duration`, `enterDelay`, optional glyph `children`.
- Icons (`~/components/icons`): `ArrowIcon`, `QontoLogo`, `QontoWordmark`, `ChevronRightIcon`, `ChevronDownIcon`, `CaretDownIcon`, `ArrowLeftIcon`, `ArrowRightIcon`, `StarIcon`, `AppleIcon`, `GooglePlayIcon`, `TrustpilotStarIcon`, `CloseIcon`, `EditIcon`, country flags, `Menu*Icon`. Mono icons use `currentColor`.
- URLs (`~/lib/asset-url`): `staticUrl(path)`, `lottieUrl(id)`, `assetUrl(id, size?)`, `VIDEO`.
- Content (`~/content/navigation`): `NAV_MENUS`, `COUNTRIES`, `FOOTER_COLUMNS`.
- `cn` from `~/lib/utils`.
- Section theme for chrome: `useSectionTheme(offset)` from `~/lib/section-theme` reads `data-header-theme`.

## Animation
- All motion through GSAP: `import { gsap, useGSAP, ScrollTrigger, EASE, prefersReducedMotion } from "~/lib/gsap"`.
- `useGSAP(fn, { scope: ref, dependencies })` for automatic cleanup; return a cleanup for manual listeners or use `contextSafe`.
- Eases match Qonto's CSS: `EASE.qonto` (0.4,0,0.2,1), `EASE.qontoOut` (0,0,0.2,1), `EASE.qontoIn` (0.4,0,1,1), `EASE.arrow` (0.4,0,0.6,1), `EASE.css` (ease), `EASE.cssOut` (ease-out), `EASE.cssInOut`.
- Respect `prefers-reduced-motion`: jump to the end state, no autoplay loops.
- Mark a file `"use client"` only when it uses hooks/GSAP/browser APIs.

## Sections
- Root is a `<section>` with Qonto's id, `data-header-theme="dark"|"light"`, and the `darkmode` class when dark.

## Code rules
- TypeScript strict, named exports, kebab-case filenames, explicit `JSX.Element` return types on exported components.
- No comments that restate code, no commented-out code, no `as any`, `@ts-ignore`, `@ts-expect-error`, non-null `!`, or empty catch blocks.
- ESLint is type-aware (no-unnecessary-condition, no-floating-promises, separate `import type`).
- Verify before finishing, from `apps/marketing`: `npx prettier --write <files>`, `pnpm typecheck`, `pnpm exec eslint --flag unstable_native_nodejs_ts_config <files>`.
