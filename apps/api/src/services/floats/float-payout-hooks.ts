import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { FloatMovementStatus } from "@expendi-business/shared";

import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { SubjectHooks } from "../payout/subjects.js";
import {
  floatMovements,
  floats,
  memberships,
  users,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { notify } from "../notification/notify.js";
import { PayoutRejected } from "../payout/payout-errors.js";
import { requireConfirmedPayoutPhone } from "../phone-verification/payout-phone.js";

/**
 * A float's issue or top-up follows its payout (spec §6.7, §6.22). The
 * movement is `pending` from the moment its payout is prepared; approval
 * only re-checks it, under the approval's locks, and refuses unless the
 * float is still open, the movement still asks for exactly what the payout
 * pays, and the holder still holds the confirmed M-Pesa number it pays.
 * The payout ending `paid` or `failed` moves the movement with it, and only
 * then does it count toward the float's balance (or stop waiting).
 *
 * Unlike a claim, a float payout always has its movement: one without
 * (e.g. the engine driven by hand) is refused at approval, so no money
 * leaves for a float nobody can account for.
 */

const SYSTEM = { type: "system", id: "float-payouts" } as const;

const refuse = (message: string) =>
  Effect.fail(new PayoutRejected({ reason: "subject_not_payable", message }));

/** Locks the float, then its movement, in the order every float write takes them. */
function lockMovementOf(tx: Transaction, payout: Payout) {
  return Effect.gen(function* () {
    const [found] = yield* query(() =>
      tx
        .select({ floatId: floatMovements.floatId })
        .from(floatMovements)
        .where(
          and(
            eq(floatMovements.id, payout.subjectId),
            eq(floatMovements.organizationId, payout.organizationId),
          ),
        ),
    );
    if (!found) return null;
    const [float] = yield* query(() =>
      tx
        .select({
          id: floats.id,
          status: floats.status,
          membershipId: floats.membershipId,
        })
        .from(floats)
        .where(eq(floats.id, found.floatId))
        .for("update"),
    );
    const [movement] = yield* query(() =>
      tx
        .select({
          id: floatMovements.id,
          type: floatMovements.type,
          status: floatMovements.status,
          amountKes: floatMovements.amountKes,
          payoutId: floatMovements.payoutId,
        })
        .from(floatMovements)
        .where(eq(floatMovements.id, payout.subjectId))
        .for("update"),
    );
    return float && movement ? { float, movement } : null;
  });
}

function approveFloatPayment(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, PayoutRejected | DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const { approvedBy, approvedAt, approvalId } = payout;
    if (!approvedBy || !approvedAt || !approvalId) {
      return yield* Effect.dieMessage(
        `payout ${payout.id} reached its subject unapproved`,
      );
    }
    const locked = yield* lockMovementOf(tx, payout);
    if (!locked) {
      return yield* refuse(
        "This payment isn't for a petty cash float any more. Nothing was sent.",
      );
    }
    const { float, movement } = locked;
    if (float.status !== "open") {
      return yield* refuse(
        "This float was closed after the payment was prepared. Nothing was sent.",
      );
    }
    if (
      (movement.type !== "issue" && movement.type !== "top_up") ||
      movement.status !== "pending" ||
      movement.payoutId !== payout.id
    ) {
      return yield* refuse(
        "This float payment was replaced after it was prepared. Nothing was sent.",
      );
    }
    if (movement.amountKes !== payout.requestedKesCents) {
      return yield* refuse(
        "This float payment changed after it was prepared. Nothing was sent.",
      );
    }

    const [holder] = yield* query(() =>
      tx
        .select({
          userId: memberships.userId,
          role: memberships.role,
          status: memberships.status,
          name: sql<string>`coalesce(${users.fullName}, ${users.email})`,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.id, float.membershipId)),
    );
    if (holder?.status !== "active" || holder.role === "accountant") {
      return yield* refuse(
        "The float's holder is no longer in the company. Nothing was sent.",
      );
    }
    const phone = yield* requireConfirmedPayoutPhone(tx, holder.userId).pipe(
      Effect.catchTag("PayoutPhoneNotConfirmed", () =>
        refuse(
          `${holder.name} no longer has a confirmed M-Pesa number. Nothing was sent.`,
        ),
      ),
    );
    if (
      payout.recipient.method !== "mpesa_phone" ||
      payout.recipient.phone !== phone
    ) {
      return yield* refuse(
        `${holder.name}'s M-Pesa number changed after the payment was prepared. Nothing was sent. Approve again to pay their new number.`,
      );
    }

    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: { type: "user", id: approvedBy },
      organizationId: payout.organizationId,
      action: "float.payment_approved",
      entity: { type: "float_movement", id: movement.id },
      after: {
        floatId: float.id,
        type: movement.type,
        payoutId: payout.id,
        approvalId,
        amountKes: payout.amountKes,
        selfApproval: holder.userId === approvedBy,
      },
    });
  });
}

/** Where a pending issue or top-up goes when its payout reaches `status`. */
const OUTCOMES: Partial<
  Record<
    Payout["status"],
    { readonly status: FloatMovementStatus; readonly action: string }
  >
> = {
  paid: { status: "paid", action: "float.payment_paid" },
  failed: { status: "failed", action: "float.payment_failed" },
};

function followPayout(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, DatabaseError, AuditLog> {
  const outcome = OUTCOMES[payout.status];
  if (!outcome) return Effect.void;
  return Effect.gen(function* () {
    const [moved] = yield* query(() =>
      tx
        .update(floatMovements)
        .set({
          status: outcome.status,
          ...(outcome.status === "paid" && {
            paidAt: payout.paidAt ?? new Date(),
          }),
        })
        .where(
          and(
            eq(floatMovements.id, payout.subjectId),
            eq(floatMovements.organizationId, payout.organizationId),
            eq(floatMovements.payoutId, payout.id),
            eq(floatMovements.status, "pending"),
          ),
        )
        .returning({
          id: floatMovements.id,
          floatId: floatMovements.floatId,
          type: floatMovements.type,
          paidAt: floatMovements.paidAt,
        }),
    );
    if (!moved) return;
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: SYSTEM,
      organizationId: payout.organizationId,
      action: outcome.action,
      entity: { type: "float_movement", id: moved.id },
      before: { status: "pending" },
      after: {
        status: outcome.status,
        floatId: moved.floatId,
        payoutId: payout.id,
        ...(outcome.status === "paid"
          ? {
              paidAt: moved.paidAt,
              amountKes: payout.amountKes,
              providerReference: payout.providerReference,
            }
          : { reason: payout.failureReason }),
      },
    });
    if (outcome.status === "paid") {
      yield* notify(tx, {
        kind: moved.type === "issue" ? "float_issued" : "float_topped_up",
        organizationId: payout.organizationId,
        movementId: moved.id,
      });
    }
  });
}

export const floatPayoutHooks: SubjectHooks = {
  approved: approveFloatPayment,
  changed: followPayout,
};
