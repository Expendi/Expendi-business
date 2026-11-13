import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseError } from "../../errors.js";
import type { Snapshot, Step } from "./move-state.js";
import type { ReturnDeps } from "./return-engine.js";
import { treasuryMoves, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { openTreasuryReturnQuote } from "../intents/treasury-quote.js";
import { endMove, isDeposited, load } from "./move-state.js";
import { stepReturn } from "./return-engine.js";

/**
 * A move to Treasury whose vault deposit Privy rejected three times sits in
 * `needs_review` with that part's USDC in the Treasury wallet
 * (docs/work/treasury/spec.md, section 11). Staff send exactly that part back
 * to the company wallet on the same path a move to the wallet uses, and the
 * move ends `returned` once the deposit watcher has credited it.
 */

/**
 * What a move's parts delivered to the Treasury wallet that no deposit took:
 * the quotes 1Click reported delivered, less those with a successful deposit.
 */
export function undepositedUsdc(snap: Snapshot): bigint {
  return snap.quotes
    .filter(
      (quote) => quote.status === "succeeded" && !isDeposited(snap, quote),
    )
    .reduce((sum, quote) => sum + (quote.swappedAmountOut ?? 0n), 0n);
}

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

const notStranded = (message: string) => new Conflict({ message });

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
    const amountUsdc = undepositedUsdc(snap);
    const existing = snap.returns[0];
    if (existing !== undefined && move.status === "open") {
      return { moveId: move.id, amountUsdc, quoteId: existing.id };
    }
    if (move.status !== "needs_review") {
      return yield* Effect.fail(
        notStranded(
          "The move isn't waiting for review, so nothing is stranded.",
        ),
      );
    }
    if (
      snap.actions.some(
        (action) =>
          action.status === "saved" ||
          action.status === "pending" ||
          action.status === "failed",
      ) ||
      snap.quotes.some((quote) =>
        ["quoted", "depositing", "needs_review"].includes(quote.status),
      )
    ) {
      return yield* Effect.fail(
        notStranded(
          "A deposit or a transfer of this move may still be in flight or reverted. Check it before sending anything back.",
        ),
      );
    }
    if (amountUsdc <= 0n) {
      return yield* Effect.fail(
        notStranded("This move has no undeposited USDC to send back."),
      );
    }

    const quote = yield* openTreasuryReturnQuote({
      organizationId,
      moveId: move.id,
      quoteKey: `treasury-return:${move.id}:0`,
      amountIn: amountUsdc,
    }).pipe(
      Effect.catchTag("QuoteNotOpened", (error) =>
        Effect.fail(
          new ServiceUnavailable({
            message: `The return couldn't be quoted: ${error.message}`,
          }),
        ),
      ),
    );

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
            quoteId: quote.id,
            undepositedUsdc: amountUsdc,
          },
        });
      }),
    );
    return { moveId: move.id, amountUsdc, quoteId: quote.id };
  });
}
