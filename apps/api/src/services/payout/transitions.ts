import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import { payouts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { applyPayoutOutcome } from "./subjects.js";

/**
 * Moves a payout out of `from`, audited, with what it pays following it in
 * the same transaction. If something else moved it first, nothing changes
 * and the payout comes back as it now stands.
 */
export function movePayout(input: {
  readonly payout: Pick<Payout, "id" | "organizationId">;
  readonly from: Payout["status"];
  readonly changes: Partial<typeof payouts.$inferInsert>;
  readonly action: string;
  readonly after: Record<string, unknown>;
  readonly actor: AuditActor;
}): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  const { id, organizationId } = input.payout;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [updated] = yield* query(() =>
        tx
          .update(payouts)
          .set(input.changes)
          .where(and(eq(payouts.id, id), eq(payouts.status, input.from)))
          .returning(),
      );
      if (!updated) {
        const [current] = yield* query(() =>
          tx.select().from(payouts).where(eq(payouts.id, id)),
        );
        return current ?? (yield* Effect.dieMessage(`payout ${id} vanished`));
      }
      yield* audit.record(tx, {
        actor: input.actor,
        organizationId,
        action: input.action,
        entity: { type: "payout", id },
        before: { status: input.from },
        after: { status: updated.status, ...input.after },
      });
      yield* applyPayoutOutcome(tx, updated);
      return updated;
    }),
  );
}

/** Ends a payout `failed`: nothing was sent for it and nothing will be. */
export const failPayout = (payout: Payout, reason: string, actor: AuditActor) =>
  movePayout({
    payout,
    from: payout.status,
    changes: { status: "failed", failureReason: reason },
    action: "payout.failed",
    after: { reason },
    actor,
  });

/** Hands a payout to a person: where its money is isn't certain. */
export const reviewPayout = (
  payout: Payout,
  reason: string,
  actor: AuditActor,
) =>
  movePayout({
    payout,
    from: payout.status,
    changes: { status: "needs_review", failureReason: reason },
    action: "payout.needs_review",
    after: { reason },
    actor,
  });
