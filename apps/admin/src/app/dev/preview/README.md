# Dev preview

Admin pages in the real shell, with sample data (Mwangaza Logistics and four
other companies, seen by the ops admin Amina Hassan, today 11 Nov 2026), and
no sign-in.

## Start it

```sh
pnpm --filter @expendi-business/admin exec next dev -p 3031
```

No env values are needed: in development, `/dev/*` routes skip Privy and the
env check (`app/providers.tsx`), and the API is replaced by sample data
(`_harness/preview-api.ts`). Then open `http://localhost:3031/dev/preview/<page>`:

| Page                         | Shows                                             |
| ---------------------------- | ------------------------------------------------- |
| `companies`                  | `/companies`                                      |
| `company`                    | `/companies/[id]`                                 |
| `company-imports`            | `/companies/[id]/imports`                         |
| `company-zoho`               | `/companies/[id]/zoho`                            |
| `intent-quotes`              | `/intent-quotes`                                  |
| `intent-quote`               | `/intent-quotes/[id]`, a quote under review       |
| `payouts`                    | `/payouts` (`?status=failed` filters it)          |
| `payout`                     | `/payouts/[id]`, a payout that needs review       |
| `payout-pretium`             | `/payouts/[id]`, a Pretium cash-out with a refund |
| `alerts`                     | `/alerts`                                         |
| `health`                     | `/health`                                         |
| `controls`                   | `/controls`, Paycrest active, Pretium ready       |
| `controls-pretium-active`    | `/controls`, Pretium active                       |
| `controls-pretium-not-ready` | `/controls`, Pretium not ready, with its problems |
| `audit-log`                  | `/audit-log`                                      |
| `zoho-books`                 | `/zoho-books`                                     |

Add `?role=viewer` to see a page as an ops viewer, who can look but not
change anything.

## Add a page

1. Put its sample data in `_harness/fixtures/`, typed with the
   `@expendi-business/shared` types so it keeps up with the API.
2. Seed it in `_harness/seed.ts` under the query keys the page's hooks use
   (`lib/query-keys.ts`), and answer its other reads (filters, other tabs) in
   `_harness/preview-api.ts`. A read with no sample data stays loading and the
   console names it; writes fail with "The preview doesn't send changes".
3. Add the view to `PAGE_PREVIEWS` in `_harness/pages.tsx`, with its route so
   the sidebar marks it. For another state of the same page, add a second
   entry whose `seed` replaces the data that differs.

Links inside a preview go to the real routes, which need a staff sign-in.

## Production

The route answers 404 outside development, and imports the harness only
inside a `process.env.NODE_ENV === "development"` branch, so the sample data
never reaches a production build.
