# Navigation and consent QA

**Result:** final production run at `http://localhost:3004` passed **46/46 checks**, with zero browser runtime errors. The separate live-reference run passed both viewport captures (all six menus at 1440 and 1024px).

## Reproduce

From `apps/marketing` (Chromium installed for Playwright):

```sh
node scripts/qa-navigation.mjs
QA_BASE_URL=http://localhost:3004 node scripts/qa-navigation.mjs
QA_REFERENCE=1 node scripts/qa-navigation.mjs
```

`QA_BASE_URL` defaults to `http://localhost:3003`. `QA_REFERENCE=1` additionally captures live `qonto.com/en` menus at 1440 and 1024px. `QA_OUTPUT` overrides the default `docs/design-references/qa-navigation` evidence directory. Failed assertions produce a nonzero exit status.

## Fixes

- **Mobile navigation was entirely off-screen.** At 390px, opening the drawer left `translate(390px, 0)` in addition to its percentage transform; all six category buttons remained outside the viewport. Resetting both horizontal translation components fixes the drawer and submenus. Closing visibility is now part of a scoped GSAP timeline, with pending tweens killed before interruption. Closing still slides normally; reduced motion closes instantly.
- **Open menus survived breakpoint changes.** Opening a mobile drawer, resizing to desktop, then returning to mobile unexpectedly reopened and relocked it. The breakpoint listener now resets drawer, submenu, and desktop-menu state and cleans up on unmount.
- **Desktop menus clipped at 1024px.** Business account measured `x=-102, width=1228`, cutting off links. Live Qonto measured `x=0, width≈1024`. The panel now caps its width to the viewport and shares available width among columns while retaining the original 1440px dimensions.
- **Custom cookie choices were discarded.** Save previously persisted only the string `customized`. It now persists the individual purpose choices with that status. Existing accepted/declined storage remains compatible.
- **Reduced-motion closing deferred visibility in production.** A zero-duration timeline moved the drawer off-screen immediately but hid it only on the next GSAP tick. The zero-duration path now applies its final transform and visibility synchronously with `gsap.set()`; both mobile and tablet production assertions pass.

## Coverage and evidence

`../design-references/qa-navigation/results.json` contains individual pass/fail results and measured geometry. PNGs in that directory capture all six desktop menus, live reference menus, and mobile drawers.

Visual review of the 1440px Business account panel confirms the original 1228×476 card at `(130, 96)` is preserved. The 390px drawer matches the captured source layout. `reference-results.json` retains the live-source geometry run; that run also captured one transient footer hydration mismatch during a concurrent `<h3>`/`<span>` edit.

- All six desktop menus: hover, pointer bridge, sibling dimming, keyboard opening, Escape, panel bounds.
- Header country picker: eight country destinations, pointer bridge, keyboard opening, Escape, outside press.
- Mobile/tablet at 390 and 768px: touch opening, all six submenus, back, close, Escape, scroll lock restoration, desktop/mobile breakpoint reset, country picker.
- Header themes: all reachable declared section boundaries in both directions on desktop; light/dark transitions on mobile/tablet.
- Footer locale: desktop hover/keyboard/outside dismissal, mobile/tablet touch toggling and panel bounds; link underline hover/reset.
- Cookie decline, accept, and mixed custom preferences: desktop/mobile, normal/reduced motion, disabled Save until complete, stored values, reload persistence, scroll unlock; desktop button hover opacity.
- Normal and reduced motion; browser runtime-error collection.

Additional interruption probe: open → close → reopen during travel settles at `x=0, visibility=visible`; normal closing remains visible mid-slide, then hides at `x=390`; reduced motion immediately reaches the final state.

## Static checks and gaps

- Package-wide ESLint and TypeScript checks pass, including the geometry script; `git diff --check` passes.
- Production build passes with the existing `metadataBase` fallback warning. All 46 navigation checks pass against that production server on `:3004`.
- Browser checks use headless Chromium. External country destinations are checked as links, not followed through third-party pages. Safari and Firefox were not tested.
