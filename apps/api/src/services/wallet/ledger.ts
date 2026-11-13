import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { UNSETTLED_TREASURY_MOVE_STATUSES } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  payouts,
  RESERVING_STATUSES,
  treasuryMoves,
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

/**
 * USDC an open move to Treasury has yet to debit: what was requested less
 * what its parts have already debited (`to_treasury` rows), never below
 * zero. A move in needs_review counts too: its money may be about to leave.
 * Until a part's send executes its USDC is still in the ledger balance, so
 * this is what keeps a payout from spending it first.
 */
export function reservedForTreasury(
  tx: Transaction,
  walletId: string,
): Effect.Effect<bigint, DatabaseError> {
  return query(() =>
    tx
      .select({
        reserved: sql<string>`coalesce(sum(greatest(treasury_moves.requested_usdc - coalesce((
          SELECT -sum(debit.usdc_amount)
          FROM wallet_transactions AS debit
          WHERE debit.treasury_move_id = treasury_moves.id
            AND debit.type::text = 'to_treasury'
        ), 0), 0)), 0)::text`,
      })
      .from(treasuryMoves)
      .where(
        and(
          eq(treasuryMoves.walletId, walletId),
          eq(treasuryMoves.direction, "to_treasury"),
          inArray(treasuryMoves.status, [...UNSETTLED_TREASURY_MOVE_STATUSES]),
        ),
      ),
  ).pipe(Effect.map(([row]) => BigInt(row?.reserved ?? "0")));
}

/**
 * What the wallet can spend now, in USDC base units: the ledger balance less
 * what payouts and an open move to Treasury have reserved. It can be
 * negative; callers that show it floor it at zero.
 */
export function availableUsdc(
  tx: Transaction,
  walletId: string,
): Effect.Effect<bigint, DatabaseError> {
  return Effect.all([
    ledgerBalance(tx, walletId),
    reservedForPayouts(tx, walletId),
    reservedForTreasury(tx, walletId),
  ]).pipe(
    Effect.map(
      ([balance, forPayouts, forTreasury]) =>
        balance - forPayouts - forTreasury,
    ),
  );
}
