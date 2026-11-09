import { and, eq, gte, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { CardBalance } from "@expendi-business/shared";
import { CARD_BALANCE_LOW_USD_CENTS } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  cardLoads,
  cardPrograms,
  cardPurchases,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

export interface CardBalanceTotals {
  readonly loaded: bigint;
  readonly spent: bigint;
  readonly refunded: bigint;
  readonly onHold: bigint;
  readonly available: bigint;
}

/**
 * The Card balance, always worked out from Card loads and purchases. Lithic's
 * sandbox can't hold one, so this is the only record of it.
 */
export function readCardBalance(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<CardBalanceTotals, DatabaseError> {
  return Effect.gen(function* () {
    const [loads] = yield* query(() =>
      tx
        .select({
          total: sql<string>`coalesce(sum(${cardLoads.amountUsdCents}), 0)::text`,
        })
        .from(cardLoads)
        .where(eq(cardLoads.organizationId, organizationId)),
    );
    const [purchases] = yield* query(() =>
      tx
        .select({
          spent: sql<string>`coalesce(sum(${cardPurchases.settledUsdCents}) FILTER (WHERE ${cardPurchases.kind} = 'purchase'), 0)::text`,
          refunded: sql<string>`coalesce(sum(${cardPurchases.settledUsdCents}) FILTER (WHERE ${cardPurchases.kind} = 'refund'), 0)::text`,
          onHold: sql<string>`coalesce(sum(${cardPurchases.holdUsdCents}), 0)::text`,
        })
        .from(cardPurchases)
        .where(eq(cardPurchases.organizationId, organizationId)),
    );
    const loaded = BigInt(loads?.total ?? "0");
    const spent = BigInt(purchases?.spent ?? "0");
    const refunded = BigInt(purchases?.refunded ?? "0");
    const onHold = BigInt(purchases?.onHold ?? "0");
    return {
      loaded,
      spent,
      refunded,
      onHold,
      available: loaded + refunded - spent - onHold,
    };
  });
}

export function cardBalanceResponse(totals: CardBalanceTotals): CardBalance {
  return {
    loadedUsdCents: totals.loaded.toString(),
    spentUsdCents: totals.spent.toString(),
    refundedUsdCents: totals.refunded.toString(),
    onHoldUsdCents: totals.onHold.toString(),
    availableUsdCents: totals.available.toString(),
  };
}

export function isCardBalanceLow(totals: CardBalanceTotals): boolean {
  return totals.available < CARD_BALANCE_LOW_USD_CENTS;
}

/**
 * Takes the company's card program row lock, so Card loads and purchase
 * checks queue instead of both spending the same balance. Null when the
 * company hasn't turned cards on.
 */
export function lockCardProgram(tx: Transaction, organizationId: string) {
  return query(() =>
    tx
      .select()
      .from(cardPrograms)
      .where(eq(cardPrograms.organizationId, organizationId))
      .for("update"),
  ).pipe(Effect.map(([program]) => program ?? null));
}

/** Start of today in Nairobi, where "today" for the daily cap is (§7.4). */
const startOfNairobiDay = sql`(date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi')`;

/** Today's Card loads in KES cents; they count against the daily cap. */
export function cardLoadsTodayKes(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<bigint, DatabaseError> {
  return query(() =>
    tx
      .select({
        total: sql<string>`coalesce(sum(${cardLoads.amountKes}), 0)::text`,
      })
      .from(cardLoads)
      .where(
        and(
          eq(cardLoads.organizationId, organizationId),
          gte(cardLoads.createdAt, startOfNairobiDay),
        ),
      ),
  ).pipe(Effect.map(([row]) => BigInt(row?.total ?? "0")));
}
