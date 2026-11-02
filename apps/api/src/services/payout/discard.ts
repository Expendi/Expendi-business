import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import { payouts } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { lockPayout } from "./guards.js";
import { applyPayoutOutcome } from "./subjects.js";

/**
 * Withdraws a payout nobody has approved, e.g. one prepared for a claim
 * whose amount or payout number has changed since. It ends `failed` with
 * nothing sent, which frees its subject to be prepared again under a new
 * idempotency key. Anything past `awaiting_approval` is left alone and
 * comes back as null.
 */
export function discardUnapprovedPayout(
  tx: Transaction,
  input: {
    readonly organizationId: string;
    readonly payoutId: string;
    readonly reason: string;
    readonly actor: AuditActor;
  },
): Effect.Effect<Payout | null, DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const locked = yield* lockPayout(tx, input.payoutId);
    if (
      locked?.organizationId !== input.organizationId ||
      locked.status !== "awaiting_approval"
    ) {
      return null;
    }
    const [discarded] = yield* query(() =>
      tx
        .update(payouts)
        .set({ status: "failed", failureReason: input.reason })
        .where(
          and(
            eq(payouts.id, input.payoutId),
            eq(payouts.status, "awaiting_approval"),
          ),
        )
        .returning(),
    );
    if (!discarded) return null;
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: input.actor,
      organizationId: input.organizationId,
      action: "payout.discarded",
      entity: { type: "payout", id: discarded.id },
      before: { status: "awaiting_approval" },
      after: { status: "failed", reason: input.reason },
    });
    yield* applyPayoutOutcome(tx, discarded);
    return discarded;
  });
}
