import { Data, Effect } from "effect";

import type { PaycrestError, PaycrestRate } from "./paycrest-client.js";
import {
  fromMicro,
  roundUpToWholeShilling,
  toMicro,
  usdcCovering,
} from "./amounts.js";
import { Paycrest } from "./paycrest-client.js";

/** Paycrest's smallest order: 0.5 USDC. */
export const MIN_ORDER_USDC = 500_000n;

/**
 * Rates depend on the order size, so size the order with a small probe
 * rate, then re-quote at the real size, then (spec §6.7) once more if that
 * moved the order into a different rate band.
 */
export const PROBE_USDC = "1";
const MAX_REQUOTES = 2;

export class AmountTooSmall extends Data.TaggedError("AmountTooSmall")<{
  readonly usdcAmount: bigint;
}> {}

export interface KesPayoutQuote {
  /** What was asked for, in KES cents. */
  readonly requestedKesCents: bigint;
  /** What the recipient receives: rounded up to a whole shilling, in cents. */
  readonly payoutKesCents: bigint;
  /** USDC (base units) Paycrest converts; never less than the payout needs. */
  readonly usdcAmount: bigint;
  readonly rate: string;
  readonly providerIds: readonly string[];
}

const sameRate = (a: PaycrestRate, b: PaycrestRate): boolean =>
  toMicro(a.rate) === toMicro(b.rate);

export function quoteKesPayout(
  requestedKesCents: bigint,
): Effect.Effect<KesPayoutQuote, PaycrestError | AmountTooSmall, Paycrest> {
  return Effect.gen(function* () {
    const paycrest = yield* Paycrest;
    const payoutKesCents = roundUpToWholeShilling(requestedKesCents);

    let quoted = yield* paycrest.rate(PROBE_USDC);
    let usdcAmount = usdcCovering(payoutKesCents, quoted.rate);
    for (let requote = 0; requote < MAX_REQUOTES; requote += 1) {
      const atSize = yield* paycrest.rate(fromMicro(usdcAmount));
      const changedBand = !sameRate(atSize, quoted);
      quoted = atSize;
      if (!changedBand) break;
      usdcAmount = usdcCovering(payoutKesCents, quoted.rate);
    }

    if (usdcAmount < MIN_ORDER_USDC) {
      return yield* Effect.fail(new AmountTooSmall({ usdcAmount }));
    }
    return {
      requestedKesCents,
      payoutKesCents,
      usdcAmount,
      rate: quoted.rate,
      providerIds: quoted.providerIds,
    };
  });
}
