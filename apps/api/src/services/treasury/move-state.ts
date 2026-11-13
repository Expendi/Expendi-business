import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
  Wallet,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { EarnActionRecord } from "../wallet/privy-wallets.js";
import {
  intentQuotes,
  treasuryEarnActions,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { notify } from "../notification/notify.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { earnVaultId } from "./turn-on.js";

/**
 * What a step of a Treasury move reads and writes, whichever way the money
 * goes (docs/work/treasury/spec.md, sections 4 and 11): the saved rows of
 * one move, the one place a move ends, and the one way a Privy Earn call is
 * kept from running twice.
 */

export const ACTOR = { type: "system", id: "treasury-moves" } as const;

/** Privy keeps an idempotency key for 24 hours; a repeat is never sent near that. */
const UNKNOWN_CALL_LIMIT_MS = 60 * 60_000;

export interface TreasuryAdvanceOptions {
  /** How long after a rejected deposit the next attempt waits; tests pass 0. */
  readonly retryDelayMs?: number;
}

export interface Snapshot {
  readonly move: TreasuryMove;
  readonly wallet: Wallet;
  /** The company wallet's quotes to Treasury, oldest first: one per attempt at a part. */
  readonly quotes: readonly IntentQuote[];
  /** The Treasury wallet's quotes back to the company wallet, oldest first. */
  readonly returns: readonly IntentQuote[];
  readonly actions: readonly TreasuryEarnAction[];
  /** Quotes whose send has already been debited. */
  readonly debited: ReadonlySet<string>;
  /** What the watcher has credited as `from_treasury`, by the return quote it delivered. */
  readonly creditedByQuote: ReadonlyMap<string, bigint>;
}

export interface Step {
  readonly move: TreasuryMove | null;
  /** Whether something changed that a following step may build on. */
  readonly progressed: boolean;
}

export const idle = (move: TreasuryMove | null): Step => ({
  move,
  progressed: false,
});
export const moved = (move: TreasuryMove | null): Step => ({
  move,
  progressed: true,
});

export function load(
  organizationId: string,
  moveId: string,
): Effect.Effect<Snapshot | null, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [move] = yield* query(() =>
        tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, moveId)),
      );
      if (!move) return null;
      const [wallet] = yield* query(() =>
        tx.select().from(wallets).where(eq(wallets.id, move.walletId)),
      );
      if (!wallet) return null;
      const allQuotes = yield* query(() =>
        tx
          .select()
          .from(intentQuotes)
          .where(eq(intentQuotes.treasuryMoveId, moveId))
          .orderBy(asc(intentQuotes.createdAt), asc(intentQuotes.id)),
      );
      const actions = yield* query(() =>
        tx
          .select()
          .from(treasuryEarnActions)
          .where(eq(treasuryEarnActions.treasuryMoveId, moveId))
          .orderBy(
            asc(treasuryEarnActions.createdAt),
            asc(treasuryEarnActions.attempt),
          ),
      );
      const rows = yield* query(() =>
        tx
          .select({
            type: walletTransactions.type,
            quoteId: walletTransactions.intentQuoteId,
            amount: walletTransactions.usdcAmount,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.treasuryMoveId, moveId)),
      );
      const creditedByQuote = new Map<string, bigint>();
      for (const row of rows) {
        if (row.type === "from_treasury" && row.quoteId !== null) {
          creditedByQuote.set(
            row.quoteId,
            (creditedByQuote.get(row.quoteId) ?? 0n) + row.amount,
          );
        }
      }
      return {
        move,
        wallet,
        quotes: allQuotes.filter((quote) => quote.purpose === "to_treasury"),
        returns: allQuotes.filter((quote) => quote.purpose === "from_treasury"),
        actions,
        debited: new Set(
          rows.flatMap((row) =>
            row.type === "to_treasury" && row.quoteId !== null
              ? [row.quoteId]
              : [],
          ),
        ),
        creditedByQuote,
      };
    }),
  );
}

const sumOf = (rows: readonly { readonly value: string | null }[]): bigint =>
  BigInt(rows[0]?.value ?? "0");

/**
 * What the move has debited, credited back, put in the vault, taken out of
 * it and asked of it so far.
 */
export function totalsOf(tx: Transaction, moveId: string) {
  return Effect.gen(function* () {
    const ledger = (type: "to_treasury" | "from_treasury", sign: "-" | "") =>
      query(() =>
        tx
          .select({
            value: sql<string>`coalesce(${sql.raw(sign)}sum(${walletTransactions.usdcAmount}), 0)::text`,
          })
          .from(walletTransactions)
          .where(
            and(
              eq(walletTransactions.treasuryMoveId, moveId),
              eq(walletTransactions.type, type),
            ),
          ),
      );
    const earned = (
      kind: "deposit" | "withdraw",
      column: "raw" | "delivered",
    ) =>
      query(() =>
        tx
          .select({
            value: sql<string>`coalesce(sum(${column === "raw" ? treasuryEarnActions.rawAmount : treasuryEarnActions.deliveredUsdc}), 0)::text`,
          })
          .from(treasuryEarnActions)
          .where(
            and(
              eq(treasuryEarnActions.treasuryMoveId, moveId),
              eq(treasuryEarnActions.kind, kind),
              eq(treasuryEarnActions.status, "succeeded"),
            ),
          ),
      );
    const debited = sumOf(yield* ledger("to_treasury", "-"));
    const creditedBack = sumOf(yield* ledger("from_treasury", ""));
    const deposited = sumOf(yield* earned("deposit", "raw"));
    const withdrawAsked = sumOf(yield* earned("withdraw", "raw"));
    const withdrawn = sumOf(yield* earned("withdraw", "delivered"));
    return {
      debited,
      creditedBack,
      deposited,
      withdrawAsked,
      withdrawn,
      cost: debited - creditedBack - deposited,
    };
  });
}

export const depositsOf = (snap: Snapshot, quote: IntentQuote) =>
  snap.actions.filter(
    (action) => action.kind === "deposit" && action.intentQuoteId === quote.id,
  );

export const isDeposited = (snap: Snapshot, quote: IntentQuote) =>
  depositsOf(snap, quote).some((action) => action.status === "succeeded");

export type Ending = "completed" | "returned" | "failed" | "needs_review";

/**
 * Ends the move, once: only an `open` move changes, so a second call finds
 * it settled and does nothing. The totals, the audit entry and the
 * notification are written in the same transaction. A move under review
 * keeps its totals empty until a person settles it.
 *
 * To Treasury, `moved_usdc` is what reached the vault and the cost is what
 * left the ledger less what came back and what was deposited. To the wallet,
 * `moved_usdc` is what the watcher credited to the company wallet and the cost
 * is what the withdrawal delivered to the Treasury wallet less that.
 */
export function endMove(
  snap: Snapshot,
  status: Ending,
  failure: string | null,
): Effect.Effect<Step, DatabaseError, DatabaseService | AuditLog> {
  const { organizationId, id, direction } = snap.move;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const totals = yield* totalsOf(tx, id);
      const reviewing = status === "needs_review";
      const toWallet = direction === "to_wallet";
      const movedUsdc = toWallet ? totals.creditedBack : totals.deposited;
      const costUsdc = toWallet
        ? totals.withdrawn - totals.creditedBack
        : totals.cost;
      const [ended] = yield* query(() =>
        tx
          .update(treasuryMoves)
          .set({
            status,
            failure,
            movedUsdc: reviewing ? null : movedUsdc,
            costUsdc: reviewing ? null : costUsdc,
            settledAt: reviewing ? null : new Date(),
          })
          .where(
            and(eq(treasuryMoves.id, id), eq(treasuryMoves.status, "open")),
          )
          .returning(),
      );
      if (!ended) {
        const [current] = yield* query(() =>
          tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, id)),
        );
        return idle(current ?? null);
      }
      const short =
        status === "completed" &&
        (toWallet
          ? totals.withdrawn < totals.withdrawAsked
          : totals.debited < ended.requestedUsdc);
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: `treasury_move.${status}`,
        entity: { type: "treasury_move", id },
        before: { status: "open" },
        after: {
          status,
          direction,
          requestedUsdc: ended.requestedUsdc,
          movedUsdc: ended.movedUsdc,
          costUsdc: ended.costUsdc,
          failure,
          ...(short && { partlyFilled: true }),
        },
      });
      const outcome = short
        ? ("partly_filled" as const)
        : status === "completed"
          ? null
          : status;
      yield* notify(
        tx,
        outcome === null
          ? {
              kind: "treasury_move_completed",
              organizationId,
              moveId: id,
              direction,
            }
          : {
              kind: "treasury_move_ended",
              organizationId,
              moveId: id,
              direction,
              outcome,
            },
      );
      return moved(ended);
    }),
  );
}

export const needsReview = (snap: Snapshot, reason: string) =>
  endMove(snap, "needs_review", reason);

/** Moves an Earn action to what Privy reports, once, from the status it was last seen in. */
export function applyAction(
  snap: Snapshot,
  action: TreasuryEarnAction,
  record: EarnActionRecord,
) {
  const terminal = record.status !== "pending";
  return withScope({ organizationId: snap.move.organizationId }, (tx) =>
    query(() =>
      tx
        .update(treasuryEarnActions)
        .set({
          privyActionId: record.actionId,
          status: record.status,
          shareAmount: record.shareAmount,
          txHash: record.txHash,
          failure: record.failureReason,
          settledAt: terminal ? new Date() : null,
        })
        .where(
          and(
            eq(treasuryEarnActions.id, action.id),
            eq(treasuryEarnActions.status, action.status),
          ),
        )
        .returning(),
    ),
  ).pipe(Effect.map(([updated]) => updated ?? null));
}

export const treasuryWalletOf = (wallet: Wallet) =>
  wallet.treasuryPrivyWalletId !== null && wallet.treasuryAddress !== null
    ? {
        privyWalletId: wallet.treasuryPrivyWalletId,
        address: wallet.treasuryAddress,
      }
    : null;

/**
 * Moves an Earn action Expendi has saved but Privy hasn't finished: calls
 * Privy with the saved reference if it hasn't answered, and polls the action
 * once it has one. Never sends a new reference, so an unclear answer can't
 * make a second deposit or withdrawal:
 *
 * - a lost answer is called again with the same reference, and for over an
 *   hour is for a person;
 * - a refusal of a repeated call means the first may have gone through, so
 *   it is for a person too;
 * - a refusal of the first call means nothing was signed: `rejected`.
 */
export function advanceEarnAction(
  snap: Snapshot,
  action: TreasuryEarnAction,
): Effect.Effect<
  Step,
  DatabaseError,
  DatabaseService | AuditLog | PrivyWallets
> {
  const { move, wallet } = snap;
  const { organizationId } = move;
  const noun = action.kind === "deposit" ? "vault deposit" : "vault withdrawal";
  return Effect.gen(function* () {
    const privy = yield* PrivyWallets;
    const treasury = treasuryWalletOf(wallet);
    const vault = yield* earnVaultId;
    if (treasury === null || Option.isNone(vault)) {
      return yield* needsReview(
        snap,
        `Treasury's wallet or vault isn't set up, so the ${noun} ${action.referenceId} can't be followed. Look the reference up in Privy before doing anything.`,
      );
    }

    if (action.status === "saved") {
      const startedAt = action.callStartedAt;
      if (
        startedAt !== null &&
        Date.now() - startedAt.getTime() > UNKNOWN_CALL_LIMIT_MS
      ) {
        return yield* needsReview(
          snap,
          `Privy hasn't confirmed the ${noun} ${action.referenceId} for over an hour, and it only honours a repeated call for a day. Look the reference up in Privy before doing anything.`,
        );
      }
      if (startedAt === null) {
        yield* withScope({ organizationId }, (tx) =>
          query(() =>
            tx
              .update(treasuryEarnActions)
              .set({ callStartedAt: new Date() })
              .where(
                and(
                  eq(treasuryEarnActions.id, action.id),
                  isNull(treasuryEarnActions.callStartedAt),
                ),
              ),
          ),
        );
      }
      const request = {
        privyWalletId: treasury.privyWalletId,
        vaultId: vault.value,
        rawAmount: action.rawAmount,
        referenceId: action.referenceId,
      };
      const called = yield* (
        action.kind === "deposit"
          ? privy.earnDeposit(request)
          : privy.earnWithdraw(request)
      ).pipe(Effect.either);
      if (called._tag === "Left") {
        if (called.left._tag === "SendOutcomeUnknown") return idle(move);
        if (startedAt !== null) {
          return yield* needsReview(
            snap,
            `Privy refused a repeated ${noun} ${action.referenceId} (${called.left.message}), so the first call may have gone through. Look the reference up in Privy before doing anything.`,
          );
        }
        yield* withScope({ organizationId }, (tx) =>
          query(() =>
            tx
              .update(treasuryEarnActions)
              .set({
                status: "rejected",
                failure: called.left.message,
                settledAt: new Date(),
              })
              .where(
                and(
                  eq(treasuryEarnActions.id, action.id),
                  eq(treasuryEarnActions.status, "saved"),
                ),
              ),
          ),
        );
        return moved(move);
      }
      if (
        called.right.rawAmount !== 0n &&
        called.right.rawAmount !== action.rawAmount
      ) {
        return yield* needsReview(
          snap,
          `Privy's action ${called.right.actionId} is for ${called.right.rawAmount} USDC base units, not the ${action.rawAmount} that was asked.`,
        );
      }
      yield* applyAction(snap, action, called.right);
      return moved(move);
    }

    if (action.status === "pending" && action.privyActionId !== null) {
      const read = yield* privy
        .getWalletAction({
          privyWalletId: treasury.privyWalletId,
          actionId: action.privyActionId,
        })
        .pipe(Effect.either);
      if (read._tag === "Left" || read.right.status === "pending") {
        return idle(move);
      }
      yield* applyAction(snap, action, read.right);
      return moved(move);
    }
    return idle(move);
  });
}
