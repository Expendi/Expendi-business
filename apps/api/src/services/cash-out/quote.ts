import { Data, Effect } from "effect";

import type { PaycrestError } from "../paycrest/paycrest-client.js";
import type { KesPayoutQuote } from "../paycrest/quote.js";
import type { PretiumError } from "../pretium/pretium-client.js";
import type { CashOutProvider } from "./provider.js";
import { roundUpToWholeShilling, usdcCovering } from "../paycrest/amounts.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import {
  AmountTooSmall,
  PROBE_USDC,
  quoteKesPayout,
} from "../paycrest/quote.js";
import { MAX_KES_PER_ORDER_CENTS } from "../payroll/split.js";
import { Pretium } from "../pretium/pretium-client.js";

/** Pretium's per-cash-out range for KES: 20 to 250,000 shillings. */
const PRETIUM_MIN_KES_CENTS = 2_000n;
const PRETIUM_MAX_KES_CENTS = 25_000_000n;

export class AmountTooLarge extends Data.TaggedError("AmountTooLarge")<{
  readonly payoutKesCents: bigint;
  readonly maxKesCents: bigint;
}> {}

export interface CashOutLimits {
  /**
   * Null for Paycrest, whose minimum is 0.5 USDC (`MIN_ORDER_USDC`), so in
   * shillings it moves with the rate.
   */
  readonly minKesCents: bigint | null;
  readonly maxKesCents: bigint;
}

export function cashOutLimits(provider: CashOutProvider): CashOutLimits {
  switch (provider) {
    case "paycrest":
      return { minKesCents: null, maxKesCents: MAX_KES_PER_ORDER_CENTS };
    case "pretium":
      return {
        minKesCents: PRETIUM_MIN_KES_CENTS,
        maxKesCents: PRETIUM_MAX_KES_CENTS,
      };
  }
}

/** KES per USDC for display and probes, as a decimal string. */
export function cashOutRate(
  provider: CashOutProvider,
): Effect.Effect<string, PaycrestError | PretiumError, Paycrest | Pretium> {
  switch (provider) {
    case "paycrest":
      return Effect.flatMap(Paycrest, (paycrest) =>
        paycrest.rate(PROBE_USDC),
      ).pipe(Effect.map(({ rate }) => rate));
    case "pretium":
      return Effect.flatMap(Pretium, (pretium) => pretium.rate());
  }
}

/**
 * What a cash-out of `requestedKesCents` costs in USDC through `provider`.
 * Pretium charges no fee on top and quotes one rate for every size.
 */
export function quoteKesCashOut(
  provider: CashOutProvider,
  requestedKesCents: bigint,
): Effect.Effect<
  KesPayoutQuote,
  PaycrestError | PretiumError | AmountTooSmall | AmountTooLarge,
  Paycrest | Pretium
> {
  switch (provider) {
    case "paycrest":
      return quoteKesPayout(requestedKesCents);
    case "pretium":
      return Effect.gen(function* () {
        const payoutKesCents = roundUpToWholeShilling(requestedKesCents);
        if (payoutKesCents > PRETIUM_MAX_KES_CENTS) {
          return yield* Effect.fail(
            new AmountTooLarge({
              payoutKesCents,
              maxKesCents: PRETIUM_MAX_KES_CENTS,
            }),
          );
        }
        const rate = yield* Effect.flatMap(Pretium, (pretium) =>
          pretium.rate(),
        );
        const usdcAmount = usdcCovering(payoutKesCents, rate);
        if (payoutKesCents < PRETIUM_MIN_KES_CENTS) {
          return yield* Effect.fail(new AmountTooSmall({ usdcAmount }));
        }
        return {
          requestedKesCents,
          payoutKesCents,
          usdcAmount,
          rate,
          providerIds: [],
        };
      });
  }
}
