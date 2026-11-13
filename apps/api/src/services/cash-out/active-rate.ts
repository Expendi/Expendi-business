import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { PaycrestError } from "../paycrest/paycrest-client.js";
import type { Pretium, PretiumError } from "../pretium/pretium-client.js";
import type { CashOutProvider } from "./provider.js";
import { withScope } from "../../db/scope.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { activeCashOutProvider } from "./active-provider.js";
import { cashOutRate } from "./quote.js";

/** The active cash-out provider, read in a transaction of its own. */
export const currentCashOutProvider: Effect.Effect<
  CashOutProvider,
  DatabaseError,
  DatabaseService
> = withScope({}, (tx) => activeCashOutProvider(tx));

/**
 * KES per USDC from the active cash-out provider, to show shillings or
 * value USDC in them; pricing a cash-out goes through `quoteKesCashOut`.
 * Paycrest's rate depends on the order size, so a caller valuing a known
 * amount passes it as `usdcAmount`; Pretium has one rate for every size.
 */
export function activeKesRate(
  usdcAmount?: string,
): Effect.Effect<
  string,
  DatabaseError | PaycrestError | PretiumError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.flatMap(currentCashOutProvider, (provider) =>
    provider === "paycrest" && usdcAmount !== undefined
      ? Effect.flatMap(Paycrest, (paycrest) => paycrest.rate(usdcAmount)).pipe(
          Effect.map(({ rate }) => rate),
        )
      : cashOutRate(provider),
  );
}

/**
 * `activeKesRate` for display: null when the provider can't be reached, so
 * an outage hides the KES figure instead of failing the screen. `label`
 * names the caller in the warning.
 */
export function activeKesRateOrNull(
  label: string,
): Effect.Effect<
  string | null,
  DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  const unavailable = (error: PaycrestError | PretiumError) =>
    Effect.sync(() => {
      console.warn(`[${label}] KES rate unavailable`, error.message);
      return null;
    });
  return activeKesRate().pipe(
    Effect.catchTags({
      PaycrestError: unavailable,
      PretiumError: unavailable,
    }),
  );
}
