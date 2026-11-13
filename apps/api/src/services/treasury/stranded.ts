import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { TreasuryReturnApproval } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { Snapshot, Step } from "./move-state.js";
import type { ReturnDeps } from "./return-engine.js";
import {
  treasuryMoves,
  treasuryReturnApprovals,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { openTreasuryReturnQuote } from "../intents/treasury-quote.js";
import { endMove, idle, load, moved } from "./move-state.js";
import {
  assessResume,
  assessStranded,
  undepositedUsdc,
} from "./return-eligibility.js";
import { evenPart, stepReturn } from "./return-engine.js";

/**
 * A move to Treasury whose vault deposit Privy rejected three times sits in
 * `needs_review` with that part's USDC in the Treasury wallet
 * (docs/work/treasury/spec.md, section 11). Staff send exactly that part back
 * to the company wallet on the same path a move to the wallet uses, and the
 * move ends `returned` once the deposit watcher has credited it.
 */

/** One step of a to-Treasury move being sent back from the Treasury wallet. */
export function stepStranded(
  snap: Snapshot,
): Effect.Effect<Step, DatabaseError, ReturnDeps> {
  return Effect.gen(function* () {
    const total = undepositedUsdc(snap);
    if (total <= 0n) {
      return yield* endMove(
        snap,
        "needs_review",
        "The move is being sent back from the Treasury wallet, but no undeposited USDC is left to send. Check the Treasury wallet before doing anything.",
      );
    }
    return yield* stepReturn(snap, total, () =>
      endMove(
        snap,
        "returned",
        "Privy kept rejecting the vault deposit, so the USDC was sent back to the company wallet.",
      ),
    );
  });
}

export interface StrandedReturn {
  readonly moveId: string;
  /** USDC base units the Treasury wallet holds for this move and is sending back. */
  readonly amountUsdc: bigint;
  readonly quoteId: string;
}

interface Reopen {
  readonly organizationId: string;
  readonly snap: Snapshot;
  readonly quoteId: string;
  readonly actor: {
    readonly type: "user" | "staff" | "system";
    readonly id: string;
  };
  readonly audit: Record<string, unknown>;
}

/**
 * Puts a `needs_review` move back to `open` under the company wallet's row
 * lock, so the `treasury-moves` job carries its return on, and audits it as
 * `treasury_move.return_started`. Only an `open`-able move changes, once.
 */
function reopen(input: Reopen) {
  const { organizationId, snap } = input;
  const { move } = snap;
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(eq(wallets.id, move.walletId))
            .for("update"),
        );
        const [reopened] = yield* query(() =>
          tx
            .update(treasuryMoves)
            .set({ status: "open" })
            .where(
              and(
                eq(treasuryMoves.id, move.id),
                eq(treasuryMoves.status, "needs_review"),
              ),
            )
            .returning({ id: treasuryMoves.id }),
        );
        if (!reopened) return;
        yield* audit.record(tx, {
          actor: input.actor,
          organizationId,
          action: "treasury_move.return_started",
          entity: { type: "treasury_move", id: move.id },
          before: { status: "needs_review" },
          after: {
            status: "open",
            quoteId: input.quoteId,
            ...input.audit,
          },
        });
      }),
    );
  });
}

const refusedQuote = (error: { readonly message: string }) =>
  new ServiceUnavailable({
    message: `The return couldn't be quoted: ${error.message}`,
  });

/**
 * Starts sending a stranded move's undeposited USDC back: takes the return
 * quote and puts the move back to `open`, in one transaction under the
 * company wallet's row lock, so the `treasury-moves` job carries it on. Only
 * what that move's own parts delivered and no deposit took is sent, never
 * the Treasury wallet's balance. Safe to call again: a move already being
 * sent back is returned as it is.
 *
 * Refused unless the move is `needs_review`, no Privy call of it is still
 * live or reverted, and none of its quotes is unsettled, so nothing here can
 * race a deposit that might still go through.
 */
export function returnStrandedDeposit(input: {
  readonly organizationId: string;
  readonly moveId: string;
  readonly actor: {
    readonly type: "user" | "staff" | "system";
    readonly id: string;
  };
}): Effect.Effect<
  StrandedReturn,
  NotFound | Conflict | BadRequest | ServiceUnavailable | DatabaseError,
  ReturnDeps
> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const snap = yield* load(organizationId, input.moveId);
    if (snap === null) {
      return yield* Effect.fail(new NotFound({ message: "No such move." }));
    }
    const { move } = snap;
    if (move.direction !== "to_treasury") {
      return yield* Effect.fail(
        new BadRequest({
          message: "Only a move to Treasury can have a stranded deposit.",
        }),
      );
    }
    const existing = snap.returns[0];
    if (existing !== undefined && move.status === "open") {
      return {
        moveId: move.id,
        amountUsdc: undepositedUsdc(snap),
        quoteId: existing.id,
      };
    }
    const assessed = assessStranded(snap);
    if (!assessed.ok) {
      return yield* Effect.fail(new Conflict({ message: assessed.message }));
    }
    const { amountUsdc } = assessed;

    const quote = yield* openTreasuryReturnQuote({
      organizationId,
      moveId: move.id,
      quoteKey: `treasury-return:${move.id}:0`,
      amountIn: amountUsdc,
    }).pipe(
      Effect.catchTag("QuoteNotOpened", (error) =>
        Effect.fail(refusedQuote(error)),
      ),
    );

    yield* reopen({
      organizationId,
      snap,
      quoteId: quote.id,
      actor: input.actor,
      audit: { undepositedUsdc: amountUsdc },
    });
    return { moveId: move.id, amountUsdc, quoteId: quote.id };
  });
}

/**
 * Reopens a move to the wallet whose withdrawal delivered but whose return
 * didn't finish, so the job sends back what is still owed: the delivery
 * less every part sent or on its way (`owedBackUsdc`), never the Treasury
 * wallet's balance and never more than the withdrawal delivered. The first
 * part is quoted here, so the move's latest quote isn't the unclear one that
 * sent it to review; the return engine carries on from there under the same
 * cap, refund and expiry rules as any return.
 *
 * Refused for any move that isn't a `needs_review` move to the wallet with
 * its delivery confirmed, none of its return quotes in flight or unclear,
 * and USDC still owed. Safe to call again: a move already open is returned
 * as it is.
 */
export function resumeToWalletReturn(input: {
  readonly organizationId: string;
  readonly moveId: string;
  readonly actor: {
    readonly type: "user" | "staff" | "system";
    readonly id: string;
  };
}): Effect.Effect<
  StrandedReturn,
  NotFound | Conflict | BadRequest | ServiceUnavailable | DatabaseError,
  ReturnDeps
> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const snap = yield* load(organizationId, input.moveId);
    if (snap === null) {
      return yield* Effect.fail(new NotFound({ message: "No such move." }));
    }
    const { move } = snap;
    if (move.direction !== "to_wallet") {
      return yield* Effect.fail(
        new BadRequest({
          message: "Only a move to the wallet can resume its return.",
        }),
      );
    }
    const latest = snap.returns.at(-1);
    if (latest !== undefined && move.status === "open") {
      return { moveId: move.id, amountUsdc: 0n, quoteId: latest.id };
    }
    const assessed = assessResume(snap);
    if (!assessed.ok) {
      return yield* Effect.fail(new Conflict({ message: assessed.message }));
    }
    const { amountUsdc } = assessed;

    const quote =
      assessed.unsentQuote ??
      (yield* openTreasuryReturnQuote({
        organizationId,
        moveId: move.id,
        quoteKey: `treasury-return:${move.id}:${snap.returns.length}`,
        amountIn: evenPart(amountUsdc, snap.wallet.perTransactionMaxUsdc),
      }).pipe(
        Effect.catchTag("QuoteNotOpened", (error) =>
          Effect.fail(refusedQuote(error)),
        ),
      ));

    yield* reopen({
      organizationId,
      snap,
      quoteId: quote.id,
      actor: input.actor,
      audit: { resumedReturn: true, owedUsdc: amountUsdc },
    });
    return { moveId: move.id, amountUsdc, quoteId: quote.id };
  });
}

/** The staff approval waiting on an open move, if any. */
export function pendingReturnApproval(move: {
  readonly organizationId: string;
  readonly id: string;
}): Effect.Effect<
  TreasuryReturnApproval | null,
  DatabaseError,
  DatabaseService
> {
  return withScope({ organizationId: move.organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(treasuryReturnApprovals)
        .where(
          and(
            eq(treasuryReturnApprovals.treasuryMoveId, move.id),
            isNull(treasuryReturnApprovals.consumedAt),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([approval]) => approval ?? null));
}

/** A quote 1Click can't be asked for is retried this long before a person looks. */
const APPROVAL_QUOTE_RETRY_MS = 5 * 60_000;

/**
 * Carries out a staff approval on a move staff reopened: judges the move
 * again as it is now, takes the first return quote and marks the approval
 * used, so the return engine sends the rest, a part at a time. The approval
 * is a ceiling, not an instruction: what is sent is what is owed now, and
 * if that is nothing, or more than was approved, or the move no longer fits
 * the approval, nothing is sent and the move goes back to review.
 */
export function carryOutReturnApproval(
  snap: Snapshot,
  approval: TreasuryReturnApproval,
): Effect.Effect<Step, DatabaseError, ReturnDeps> {
  const { move } = snap;
  const { organizationId } = move;
  const consume = withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .update(treasuryReturnApprovals)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(treasuryReturnApprovals.id, approval.id),
            isNull(treasuryReturnApprovals.consumedAt),
          ),
        )
        .returning({ id: treasuryReturnApprovals.id }),
    ),
  ).pipe(Effect.map((rows) => rows.length > 0));
  const decline = (why: string) =>
    Effect.gen(function* () {
      yield* consume;
      return yield* endMove(
        snap,
        "needs_review",
        `Staff approved sending ${approval.approvedUsdc} USDC base units back, but ${why} Nothing was sent. Check the Treasury wallet before doing anything.`,
      );
    });

  return Effect.gen(function* () {
    const stranded = approval.kind === "return_stranded_deposit";
    if (move.direction !== (stranded ? "to_treasury" : "to_wallet")) {
      return yield* decline("the move is not the kind it was approved for.");
    }
    const assessed = stranded
      ? assessStranded(snap, { reopened: true })
      : assessResume(snap, { reopened: true });
    if (!assessed.ok) return yield* decline(assessed.message);
    if (assessed.amountUsdc > approval.approvedUsdc) {
      return yield* decline(
        `${assessed.amountUsdc} is owed now, more than was approved.`,
      );
    }

    const opened =
      !stranded && assessed.unsentQuote
        ? ({ _tag: "Right", right: assessed.unsentQuote } as const)
        : yield* openTreasuryReturnQuote({
            organizationId,
            moveId: move.id,
            quoteKey: `treasury-return:${move.id}:${stranded ? 0 : snap.returns.length}`,
            amountIn: stranded
              ? assessed.amountUsdc
              : evenPart(
                  assessed.amountUsdc,
                  snap.wallet.perTransactionMaxUsdc,
                ),
          }).pipe(Effect.either);
    if (opened._tag === "Left") {
      if (opened.left._tag === "DatabaseError") {
        return yield* Effect.fail(opened.left);
      }
      if (
        opened.left.reason === "one_click_unavailable" &&
        Date.now() - approval.createdAt.getTime() < APPROVAL_QUOTE_RETRY_MS
      ) {
        return idle(move);
      }
      return yield* decline(
        `the return couldn't be quoted: ${opened.left.message}`,
      );
    }
    return (yield* consume) ? moved(move) : idle(move);
  });
}
