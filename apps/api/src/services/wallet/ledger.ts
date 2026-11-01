import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  payouts,
  RESERVING_STATUSES,
  walletTransactions,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/** The ledger balance in USDC base units: what has settled on chain. */
export function ledgerBalance(
  tx: Transaction,
  walletId: string,
): Effect.Effect<bigint, DatabaseError> {
  return query(() =>
    tx
      .select({
        balance: sql<string>`coalesce(sum(${walletTransactions.usdcAmount}), 0)::text`,
      })
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, walletId)),
  ).pipe(Effect.map(([row]) => BigInt(row?.balance ?? "0")));
}

/**
 * USDC promised to payouts that haven't been debited yet, at their approved
 * maximum. A payout under review counts too: its money may already be gone.
 */
export function reservedForPayouts(
  tx: Transaction,
  walletId: string,
): Effect.Effect<bigint, DatabaseError> {
  return query(() =>
    tx
      .select({
        reserved: sql<string>`coalesce(sum(${payouts.maxDebitUsdc}), 0)::text`,
      })
      .from(payouts)
      .where(
        and(
          eq(payouts.walletId, walletId),
          inArray(payouts.status, [...RESERVING_STATUSES, "needs_review"]),
        ),
      ),
  ).pipe(Effect.map(([row]) => BigInt(row?.reserved ?? "0")));
}
