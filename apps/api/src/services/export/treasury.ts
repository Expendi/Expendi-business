import { and, desc, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { Effect } from "effect";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { MonthBounds } from "./month.js";
import {
  intentQuotes,
  treasuryEarnActions,
  treasuryMoves,
  treasurySnapshots,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";

/**
 * A month's Treasury figures for the accountant (docs/work/treasury/spec.md,
 * section 5, "Accountant"), read inside one company's scope. A company gets
 * them for every month from the one it turned Treasury on in.
 *
 * - **Value** at the start and end of the month is the last daily snapshot
 *   on or before the month's first and last Nairobi day. With none, the
 *   figure is missing and says so; nothing is guessed. A company that turned
 *   Treasury on after the month began held nothing in it at the start.
 * - **Moves** are those that ended `completed` or `returned` in the month.
 *   Moved to Treasury is what reached the vault; moved to wallet is what left
 *   it (what the withdrawal delivered, which a vault may fill in part). Both
 *   are the vault's side of a move, so yield (closing, less opening, less
 *   net moved in) leaves out what 1Click charged, which is no yield.
 * - **Cost** of a move is its `cost_usdc`: for a move to the wallet, what the
 *   withdrawal delivered less what the company wallet was credited.
 */

export interface TreasuryValue {
  /** USDC base units; null when there is no snapshot to read it from. */
  readonly usdc: bigint | null;
  /** The Nairobi day of the snapshot, or null. */
  readonly snapshotDate: string | null;
  /** Why the figure is what it is, when it isn't a plain snapshot. */
  readonly note: "turned_on_later" | null;
}

export interface TreasuryMoveLine {
  readonly id: string;
  /** The Nairobi day it ended. */
  readonly date: string;
  readonly direction: "to_treasury" | "to_wallet";
  /** What left: the company wallet's debit, or what the vault gave up. */
  readonly leftUsdc: bigint;
  /** What arrived: what reached the vault, or the company wallet's credit. */
  readonly arrivedUsdc: bigint;
  readonly costUsdc: bigint;
  /** Transaction hashes of the move's sends, deposits, withdrawals and credits. */
  readonly references: readonly string[];
}

export interface TreasuryMonth {
  readonly opening: TreasuryValue;
  readonly closing: TreasuryValue;
  readonly movedToTreasuryUsdc: bigint;
  readonly movedToWalletUsdc: bigint;
  /** Null when either value is missing. */
  readonly yieldUsdc: bigint | null;
  readonly costUsdc: bigint;
  readonly moves: readonly TreasuryMoveLine[];
}

const sum = (amounts: readonly bigint[]): bigint =>
  amounts.reduce((total, amount) => total + amount, 0n);

function lastSnapshotOnOrBefore(
  tx: Transaction,
  organizationId: string,
  day: string,
) {
  return query(() =>
    tx
      .select({
        assets: treasurySnapshots.assetsInVault,
        date: treasurySnapshots.snapshotDate,
      })
      .from(treasurySnapshots)
      .where(
        and(
          eq(treasurySnapshots.organizationId, organizationId),
          lte(treasurySnapshots.snapshotDate, day),
        ),
      )
      .orderBy(desc(treasurySnapshots.snapshotDate))
      .limit(1),
  ).pipe(Effect.map(([row]) => row ?? null));
}

function readMoves(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
): Effect.Effect<TreasuryMoveLine[], DatabaseError> {
  return Effect.gen(function* () {
    const moves = yield* query(() =>
      tx
        .select()
        .from(treasuryMoves)
        .where(
          and(
            eq(treasuryMoves.organizationId, organizationId),
            inArray(treasuryMoves.status, ["completed", "returned"]),
            isNotNull(treasuryMoves.settledAt),
            gte(treasuryMoves.settledAt, month.startAt),
            lt(treasuryMoves.settledAt, month.endAt),
          ),
        )
        .orderBy(treasuryMoves.settledAt, treasuryMoves.id),
    );
    if (moves.length === 0) return [];
    const ids = moves.map((move) => move.id);
    const ledger = yield* query(() =>
      tx
        .select({
          moveId: walletTransactions.treasuryMoveId,
          type: walletTransactions.type,
          amount: walletTransactions.usdcAmount,
          txHash: walletTransactions.txHash,
        })
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.organizationId, organizationId),
            inArray(walletTransactions.treasuryMoveId, ids),
          ),
        )
        .orderBy(walletTransactions.createdAt, walletTransactions.id),
    );
    const actions = yield* query(() =>
      tx
        .select({
          moveId: treasuryEarnActions.treasuryMoveId,
          kind: treasuryEarnActions.kind,
          delivered: treasuryEarnActions.deliveredUsdc,
          txHash: treasuryEarnActions.txHash,
        })
        .from(treasuryEarnActions)
        .where(
          and(
            eq(treasuryEarnActions.organizationId, organizationId),
            inArray(treasuryEarnActions.treasuryMoveId, ids),
            eq(treasuryEarnActions.status, "succeeded"),
          ),
        )
        .orderBy(treasuryEarnActions.createdAt, treasuryEarnActions.attempt),
    );
    const quotes = yield* query(() =>
      tx
        .select({
          moveId: intentQuotes.treasuryMoveId,
          txHash: intentQuotes.depositTxHash,
        })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            inArray(intentQuotes.treasuryMoveId, ids),
          ),
        )
        .orderBy(intentQuotes.createdAt, intentQuotes.id),
    );
    return moves.map((move) => {
      const own = <T extends { readonly moveId: string | null }>(rows: T[]) =>
        rows.filter((row) => row.moveId === move.id);
      const debited = sum(
        own(ledger)
          .filter((row) => row.type === "to_treasury")
          .map((row) => -row.amount),
      );
      const withdrawn = sum(
        own(actions).flatMap((action) =>
          action.kind === "withdraw" && action.delivered !== null
            ? [action.delivered]
            : [],
        ),
      );
      const toTreasury = move.direction === "to_treasury";
      const hashes = [
        ...own(ledger).map((row) => row.txHash),
        ...own(actions).map((action) => action.txHash),
        ...own(quotes).map((quote) => quote.txHash),
      ].flatMap((hash) => (hash === null ? [] : [hash]));
      return {
        id: move.id,
        date: nairobiDate(move.settledAt ?? move.updatedAt),
        direction: move.direction,
        leftUsdc: toTreasury ? debited : withdrawn,
        arrivedUsdc: move.movedUsdc ?? 0n,
        costUsdc: move.costUsdc ?? 0n,
        references: [...new Set(hashes)],
      };
    });
  });
}

/** The month's Treasury figures, or null for a company without Treasury by then. */
export function readTreasuryMonth(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
): Effect.Effect<TreasuryMonth | null, DatabaseError> {
  return Effect.gen(function* () {
    const [wallet] = yield* query(() =>
      tx
        .select({ turnedOnAt: wallets.treasuryTurnedOnAt })
        .from(wallets)
        .where(eq(wallets.organizationId, organizationId)),
    );
    const turnedOnAt = wallet?.turnedOnAt ?? null;
    if (turnedOnAt === null || turnedOnAt.getTime() >= month.endAt.getTime()) {
      return null;
    }

    const first = yield* lastSnapshotOnOrBefore(
      tx,
      organizationId,
      month.start,
    );
    const last = yield* lastSnapshotOnOrBefore(
      tx,
      organizationId,
      month.lastDay,
    );
    const opening: TreasuryValue = first
      ? { usdc: first.assets, snapshotDate: first.date, note: null }
      : turnedOnAt.getTime() >= month.startAt.getTime()
        ? { usdc: 0n, snapshotDate: null, note: "turned_on_later" }
        : { usdc: null, snapshotDate: null, note: null };
    const closing: TreasuryValue = last
      ? { usdc: last.assets, snapshotDate: last.date, note: null }
      : { usdc: null, snapshotDate: null, note: null };

    const moves = yield* readMoves(tx, organizationId, month);
    const movedToTreasuryUsdc = sum(
      moves
        .filter((move) => move.direction === "to_treasury")
        .map((move) => move.arrivedUsdc),
    );
    const movedToWalletUsdc = sum(
      moves
        .filter((move) => move.direction === "to_wallet")
        .map((move) => move.leftUsdc),
    );
    return {
      opening,
      closing,
      movedToTreasuryUsdc,
      movedToWalletUsdc,
      yieldUsdc:
        opening.usdc === null || closing.usdc === null
          ? null
          : closing.usdc -
            opening.usdc -
            (movedToTreasuryUsdc - movedToWalletUsdc),
      costUsdc: sum(moves.map((move) => move.costUsdc)),
      moves,
    };
  });
}
