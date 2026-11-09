# Lithic sandbox (Expendi cards)

Expendi cards run only against Lithic's sandbox (spec §6.25). The API has no production URL and no card spends real money.

## Secrets

All in Doppler `expendi-business`, config `dev`. Without `LITHIC_API_KEY` the API still starts and cards are off.

| Secret                  | From                                              |
| ----------------------- | ------------------------------------------------- |
| `LITHIC_API_KEY`        | app.lithic.com, sandbox key                       |
| `LITHIC_WEBHOOK_SECRET` | `lithic-setup.ts webhook-secret`                  |
| `LITHIC_ASA_SECRET`     | `lithic-setup.ts asa-secret`                      |
| `CARD_REVEAL_ORIGIN`    | Optional. The HTTPS origin serving `/card-reveal` |

The API reads Doppler when it starts, so restart it after changing one.

## Point the sandbox at an API

Run from `apps/api`. Safe to repeat.

```sh
doppler run -p expendi-business -c dev -- pnpm exec tsx scripts/lithic-setup.ts apply --api-url https://api-dev-dcdc.up.railway.app
doppler run -p expendi-business -c dev -- pnpm exec tsx scripts/lithic-setup.ts status
```

Then store the two signing secrets without printing them:

```sh
doppler run -p expendi-business -c dev -- pnpm exec tsx scripts/lithic-setup.ts webhook-secret | doppler secrets set LITHIC_WEBHOOK_SECRET -p expendi-business -c dev > /dev/null
doppler run -p expendi-business -c dev -- pnpm exec tsx scripts/lithic-setup.ts asa-secret | doppler secrets set LITHIC_ASA_SECRET -p expendi-business -c dev > /dev/null
```

`apply` sets up three things: the `card_transaction.updated` event subscription, the purchase check (`/webhooks/lithic/authorization`), and the rule blocking cash and gambling. Only one purchase check can be enrolled per sandbox, so pointing it at another API moves it.

## Make a fake purchase

Issue a card and load the Card balance on the web dashboard first. Note the card's last four digits.

```sh
sim() { doppler run -p expendi-business -c dev -- pnpm exec tsx scripts/lithic-simulate.ts "$@"; }
sim authorize --last-four 1234 --amount 54.00 --merchant "ACME SOFTWARE"   # prints the transaction token
sim clear --tx <token> --amount 60.00                                      # settles it; a Card expense appears
sim void --tx <token>                                                      # or releases the hold instead
sim refund --last-four 1234 --amount 54.00 --merchant "ACME SOFTWARE"
sim show --tx <token>
```

## What to expect

- **Approved or not:** the simulate call doesn't say. `authorize` prints the result by reading the transaction back.
- **Over the Card balance:** declined by our purchase check with `INSUFFICIENT_FUNDS`.
- **Split clearing:** `clear --amount 7` on a $10 hold is `SETTLED` with $3 still held, and no Card expense appears until `void` releases the rest.
- **Voids** use Lithic's expiry type, because the sandbox accepts a reversal and does nothing with it.
- **A 500 when creating a company** may still have created it. The API looks it up by `external_id` before retrying.
- **Writes** are limited to about one a second.
