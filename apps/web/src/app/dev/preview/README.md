# Dev preview

Company pages in the real shell, with the mocks' sample data (Mwangaza
Logistics, seen by its admin Wanjiru Kamau, today 6 Nov 2026), and no
sign-in. Compare them side by side with `docs/mocks/*.html`.

## Start it

```sh
pnpm --filter @expendi-business/web dev
```

No env values are needed: in development, `/dev/*` routes skip Privy and
the env check (`app/providers.tsx`), and the API is replaced by sample data
(`_harness/preview-api.ts`). Then open:

- `http://localhost:3002/dev/preview/bills`, the page previews (add
  `?role=accountant` to see it read-only);
- `http://localhost:3002/dev/preview/kit`, every shared data component
  (`components/data/README.md`) in its states. `?billId=…` opens a bill's
  side sheet.

Another port: `pnpm --filter @expendi-business/web exec next dev -p 3012`.

## Add a page

1. Put its sample data in `_harness/fixtures/` (typed with the
   `@expendi-business/shared` types, so it keeps up with the API).
2. Seed it in `_harness/seed.ts` under the query keys the page's hooks use.
   A read that isn't seeded stays loading and the console names it; writes
   fail with "The preview doesn't send changes".
3. Add the view to `PAGE_PREVIEWS` in `_harness/pages.tsx`, with its route
   so the sidebar marks it.

## Production

Both routes answer 404 outside development, and they import the harness
only inside a `process.env.NODE_ENV === "development"` branch, so the
sample data never reaches a production build.

## Screenshots

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --hide-scrollbars --window-size=1440,1000 \
  --virtual-time-budget=8000 --screenshot=bills.png \
  http://localhost:3002/dev/preview/bills
```

Chrome won't make a window narrower than about 500px, so for phone widths
emulate the device through the DevTools protocol
(`Emulation.setDeviceMetricsOverride` with `width: 390`).
