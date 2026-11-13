import { Effect } from "effect";

import type { PayeeMethod } from "@expendi-business/shared";
import { cashOutAmountProblem, paysByCashOut } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { PaycrestError } from "../paycrest/paycrest-client.js";
import type { CashOutProvider } from "./provider.js";
import { BadRequest } from "../../errors.js";
import { fromMicro, toMicro } from "../paycrest/amounts.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { MIN_ORDER_USDC } from "../paycrest/quote.js";
import { currentCashOutProvider } from "./active-rate.js";
import { cashOutLimits } from "./quote.js";

export interface ActiveCashOutLimits {
  /** Null while Paycrest's rate can't be had, so its minimum is unknown. */
  readonly minKesCents: bigint | null;
  readonly maxKesCents: bigint;
}

const MICRO_SQUARED = 1_000_000_000_000n;

/**
 * The fewest whole shillings Paycrest takes at `rate`: the least amount
 * `quoteKesPayout` prices at `MIN_ORDER_USDC` or more. It prices `S`
 * shillings at ⌈S·10¹² / rate⌉ USDC units, which reaches the minimum
 * exactly when S·10¹² > (MIN_ORDER_USDC − 1)·rate.
 */
export function paycrestMinKesCents(rate: string): bigint {
  const shillings = ((MIN_ORDER_USDC - 1n) * toMicro(rate)) / MICRO_SQUARED;
  return (shillings + 1n) * 100n;
}

/** `cashOutLimits` with Paycrest's minimum in shillings at its rate now. */
export function cashOutLimitsNow(
  provider: CashOutProvider,
): Effect.Effect<ActiveCashOutLimits, never, Paycrest> {
  const limits = cashOutLimits(provider);
  if (provider !== "paycrest") return Effect.succeed(limits);
  const unknown = (error: PaycrestError) =>
    Effect.sync(() => {
      console.warn("[cash-out-limits] rate unavailable", error.message);
      return null;
    });
  return Effect.flatMap(Paycrest, (paycrest) =>
    paycrest.rate(fromMicro(MIN_ORDER_USDC)),
  ).pipe(
    Effect.map(({ rate }) => paycrestMinKesCents(rate)),
    Effect.catchTag("PaycrestError", unknown),
    Effect.map((minKesCents) => ({ ...limits, minKesCents })),
  );
}

/**
 * The smallest and largest amount one cash-out through the active cash-out
 * provider can send now. Read before any lock is taken, so none waits on
 * the provider.
 */
export const activeCashOutLimits: Effect.Effect<
  ActiveCashOutLimits,
  DatabaseError,
  DatabaseService | Paycrest
> = Effect.flatMap(currentCashOutProvider, cashOutLimitsNow);

/**
 * Refuses a KES amount one cash-out couldn't send, when `method` pays by
 * cash-out, so a bill isn't found unpayable only at "Pay". `limits` is null
 * when the request couldn't have changed what is sent. Paying checks again:
 * the provider or its rate may change in between. `details.field` names the
 * request field a form shows it on.
 */
export function checkCashOutAmount(
  method: PayeeMethod | null,
  amountKes: bigint | null,
  limits: ActiveCashOutLimits | null,
): Effect.Effect<void, BadRequest> {
  if (limits === null || amountKes === null || !paysByCashOut(method)) {
    return Effect.void;
  }
  const problem = cashOutAmountProblem(amountKes, limits);
  return problem === null
    ? Effect.void
    : Effect.fail(
        new BadRequest({ message: problem, details: { field: "amountKes" } }),
      );
}
