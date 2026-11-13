import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type {
  TreasuryProgress,
  TreasuryProgressStep,
} from "@expendi-business/shared";

import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  intentQuotes,
  treasuryEarnActions,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { committedOf } from "./return-eligibility.js";

/**
 * Where a move's money is, derived only from rows Treasury already saves:
 * the move, its quotes in both directions, its Earn actions and its
 * `to_treasury` debits. Read-only: nothing here changes how a move runs, so
 * each "done" below mirrors the condition `advance.ts` and `to-wallet.ts` act
 * on for the same step.
 */

type StepKey = TreasuryProgressStep["key"];

export interface ProgressRows {
  readonly move: TreasuryMove;
  /** The wallet's per-transfer cap, which decides how many parts are left. */
  readonly perTransactionMaxUsdc: bigint;
  readonly quotes: readonly IntentQuote[];
  readonly returns: readonly IntentQuote[];
  readonly actions: readonly TreasuryEarnAction[];
  /** When each quote's send was debited from the ledger, by quote id. */
  readonly debitedAt: ReadonlyMap<string, Date>;
}

interface Stage {
  readonly key: StepKey;
  readonly done: boolean;
  readonly at: Date | null;
}

const iso = (date: Date | null): string | null =>
  date === null ? null : date.toISOString();

const ceilDiv = (amount: bigint, cap: bigint): number =>
  Number((amount + cap - 1n) / cap);

const isDeposited = (
  actions: readonly TreasuryEarnAction[],
  quote: IntentQuote,
): TreasuryEarnAction | undefined =>
  actions.find(
    (action) =>
      action.kind === "deposit" &&
      action.intentQuoteId === quote.id &&
      action.status === "succeeded",
  );

/**
 * The first step that isn't done is where the move is: `current` while it
 * runs, `failed` once it has stopped short (returned, failed, under review).
 * Steps after it wait.
 */
function toSteps(
  stages: readonly Stage[],
  stopped: boolean,
): TreasuryProgressStep[] {
  const stoppedAt = stages.findIndex((stage) => !stage.done);
  return stages.map((stage, index) => ({
    key: stage.key,
    state: stage.done
      ? "done"
      : index === stoppedAt
        ? stopped
          ? "failed"
          : "current"
        : "waiting",
    at: stage.done ? iso(stage.at) : null,
  }));
}

function toTreasuryProgress(rows: ProgressRows): TreasuryProgress {
  const { move, actions, debitedAt, perTransactionMaxUsdc } = rows;
  const completed = move.status === "completed";
  const live = rows.quotes.filter((quote) => quote.status !== "expired");
  const landed = live.filter((quote) => isDeposited(actions, quote));
  const remaining =
    move.requestedUsdc -
    landed.reduce((sum, quote) => sum + quote.amountIn, 0n);
  const latest = live.at(-1);

  // Between parts the next quote isn't taken yet: the part to show is the
  // next one, with nothing of it done.
  const betweenParts =
    latest !== undefined &&
    isDeposited(actions, latest) !== undefined &&
    remaining > 0n &&
    move.status === "open";
  const quote = betweenParts ? undefined : latest;

  const deposit = quote ? isDeposited(actions, quote) : undefined;
  const stages: Stage[] = [
    {
      key: "leaving_wallet",
      done: quote !== undefined && debitedAt.has(quote.id),
      at: quote ? (debitedAt.get(quote.id) ?? null) : null,
    },
    {
      key: "on_its_way",
      done: quote?.status === "succeeded",
      at: quote?.settledAt ?? null,
    },
    {
      key: "arriving",
      done: deposit !== undefined,
      at: deposit?.settledAt ?? null,
    },
    { key: "in_treasury", done: completed, at: move.settledAt },
  ];

  const allLanded = completed || remaining <= 0n;
  const parts = allLanded
    ? landed.length
    : landed.length + ceilDiv(remaining, perTransactionMaxUsdc);
  return {
    steps: toSteps(stages, move.status !== "open" && !completed),
    ...(parts > 1 && {
      part: allLanded ? landed.length : landed.length + 1,
      parts,
    }),
  };
}

function toWalletProgress(rows: ProgressRows): TreasuryProgress {
  const { move, actions, returns, perTransactionMaxUsdc } = rows;
  const completed = move.status === "completed";
  const withdrawal = actions.find((action) => action.kind === "withdraw");
  const delivered = withdrawal?.deliveredUsdc ?? null;
  const withdrawn = withdrawal?.status === "succeeded" && delivered !== null;

  // Parts that left the Treasury wallet or are on their way: a refunded or
  // expired quote isn't one, since its USDC is owed again.
  const sent = returns.filter((quote) => committedOf([quote]) > 0n);
  const owed = delivered === null ? 0n : delivered - committedOf(returns);
  const latest = returns.filter((quote) => quote.status !== "expired").at(-1);
  // A part that succeeded with more still owed means the next part is the
  // one on its way.
  const betweenParts =
    latest?.status === "succeeded" && owed > 0n && move.status === "open";
  const quote = betweenParts ? undefined : latest;

  const stages: Stage[] = [
    {
      key: "leaving_treasury",
      done: withdrawn,
      at: withdrawal?.settledAt ?? null,
    },
    {
      key: "on_its_way",
      done: withdrawn && quote?.status === "succeeded",
      at: quote?.settledAt ?? null,
    },
    { key: "in_wallet", done: completed, at: move.settledAt },
  ];

  const parts =
    delivered === null
      ? 0
      : sent.length + (owed > 0n ? ceilDiv(owed, perTransactionMaxUsdc) : 0);
  const sentLatest = quote !== undefined && sent.includes(quote);
  return {
    steps: toSteps(stages, move.status !== "open" && !completed),
    ...(parts > 1 && {
      part: completed || sentLatest ? sent.length : sent.length + 1,
      parts,
    }),
  };
}

export function deriveProgress(rows: ProgressRows): TreasuryProgress {
  return rows.move.direction === "to_treasury"
    ? toTreasuryProgress(rows)
    : toWalletProgress(rows);
}

/** The progress of each move, read in one pass for however many moves there are. */
export function progressOfMoves(
  tx: Transaction,
  moves: readonly TreasuryMove[],
): Effect.Effect<ReadonlyMap<string, TreasuryProgress>, DatabaseError> {
  if (moves.length === 0) return Effect.succeed(new Map());
  const moveIds = moves.map((move) => move.id);
  const walletIds = [...new Set(moves.map((move) => move.walletId))];
  return Effect.gen(function* () {
    const quotes = yield* query(() =>
      tx
        .select()
        .from(intentQuotes)
        .where(inArray(intentQuotes.treasuryMoveId, moveIds)),
    );
    const actions = yield* query(() =>
      tx
        .select()
        .from(treasuryEarnActions)
        .where(inArray(treasuryEarnActions.treasuryMoveId, moveIds)),
    );
    const debits = yield* query(() =>
      tx
        .select({
          quoteId: walletTransactions.intentQuoteId,
          createdAt: walletTransactions.createdAt,
        })
        .from(walletTransactions)
        .where(
          and(
            inArray(walletTransactions.treasuryMoveId, moveIds),
            eq(walletTransactions.type, "to_treasury"),
          ),
        ),
    );
    const caps = yield* query(() =>
      tx
        .select({
          id: wallets.id,
          cap: wallets.perTransactionMaxUsdc,
        })
        .from(wallets)
        .where(inArray(wallets.id, walletIds)),
    );
    const capOf = new Map(caps.map((row) => [row.id, row.cap]));
    const debitedAt = new Map(
      debits.flatMap((row) =>
        row.quoteId === null ? [] : [[row.quoteId, row.createdAt] as const],
      ),
    );
    const byAge = <T extends { readonly createdAt: Date; readonly id: string }>(
      rows: readonly T[],
    ) =>
      [...rows].sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    return new Map(
      moves.map((move) => {
        const ofMove = <T extends { readonly treasuryMoveId: string | null }>(
          rowsOfAll: readonly T[],
        ) => rowsOfAll.filter((row) => row.treasuryMoveId === move.id);
        const moveQuotes = byAge(ofMove(quotes));
        return [
          move.id,
          deriveProgress({
            move,
            perTransactionMaxUsdc: capOf.get(move.walletId) ?? 1n,
            quotes: moveQuotes.filter((q) => q.purpose === "to_treasury"),
            returns: moveQuotes.filter((q) => q.purpose === "from_treasury"),
            actions: ofMove(actions),
            debitedAt,
          }),
        ] as const;
      }),
    );
  });
}
