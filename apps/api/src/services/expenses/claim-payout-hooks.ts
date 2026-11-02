import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { ExpenseStatus } from "@expendi-business/shared";

import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { SubjectHooks } from "../payout/subjects.js";
import { expenses, memberships, users } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { PayoutRejected } from "../payout/payout-errors.js";
import { requireConfirmedPayoutPhone } from "../phone-verification/payout-phone.js";

/**
 * A claim follows its payout (spec §5, §6.7, §6.8). Approval moves it from
 * `submitted` (or `payout_failed`, for a retry) to `paying`, only if the
 * claim still asks for exactly what the payout pays and the claimant still
 * holds the confirmed M-Pesa number it pays (spec §6.18). The payout ending
 * `paid` or `failed` moves it to `paid` or `payout_failed`; `needs_review`
 * leaves it `paying` until a person resolves the payout.
 *
 * A payout whose claim row doesn't exist (the engine driven directly, as
 * the Checkpoint B script does) has nothing to follow.
 */

const SYSTEM = { type: "system", id: "claim-payouts" } as const;

/** A claim can be approved for payment from these. */
const PAYABLE: readonly ExpenseStatus[] = ["submitted", "payout_failed"];

const refuse = (message: string) =>
  Effect.fail(new PayoutRejected({ reason: "subject_not_payable", message }));

function lockClaimOf(tx: Transaction, payout: Payout) {
  return query(() =>
    tx
      .select({
        id: expenses.id,
        status: expenses.status,
        amountKes: expenses.amountKes,
        claimantUserId: memberships.userId,
        claimantName: sql<string>`coalesce(${users.fullName}, ${memberships.fullName}, ${users.email}, ${memberships.email})`,
      })
      .from(expenses)
      .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(expenses.id, payout.subjectId),
          eq(expenses.organizationId, payout.organizationId),
          eq(expenses.kind, "claim"),
        ),
      )
      .for("update", { of: expenses }),
  ).pipe(Effect.map(([claim]) => claim ?? null));
}

function approveClaim(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, PayoutRejected | DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const claim = yield* lockClaimOf(tx, payout);
    if (!claim) return;
    const { approvedBy, approvedAt, approvalId } = payout;
    if (!approvedBy || !approvedAt || !approvalId) {
      return yield* Effect.dieMessage(
        `payout ${payout.id} reached its subject unapproved`,
      );
    }
    if (!PAYABLE.includes(claim.status)) {
      return yield* refuse(
        "This claim isn't waiting to be paid any more. Nothing was sent.",
      );
    }
    if (claim.amountKes !== payout.requestedKesCents) {
      return yield* refuse(
        "This claim changed after the payment was prepared. Nothing was sent. Review it and approve again.",
      );
    }
    if (!claim.claimantUserId) {
      return yield* refuse(
        `${claim.claimantName} has no app login, so they can't be paid.`,
      );
    }
    const phone = yield* requireConfirmedPayoutPhone(
      tx,
      claim.claimantUserId,
    ).pipe(
      Effect.catchTag("PayoutPhoneNotConfirmed", () =>
        refuse(
          `${claim.claimantName} hasn't confirmed an M-Pesa number, so Approve & pay is blocked until they do. Nothing was sent.`,
        ),
      ),
    );
    if (
      payout.recipient.method !== "mpesa_phone" ||
      payout.recipient.phone !== phone
    ) {
      return yield* refuse(
        `${claim.claimantName}'s M-Pesa number changed after the payment was prepared. Nothing was sent. Approve again to pay their new number.`,
      );
    }

    const selfApproval = claim.claimantUserId === approvedBy;
    yield* query(() =>
      tx
        .update(expenses)
        .set({
          status: "paying",
          approvedBy,
          approvedAt,
          selfApproved: selfApproval,
          payoutId: payout.id,
        })
        .where(eq(expenses.id, claim.id)),
    );
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: { type: "user", id: approvedBy },
      organizationId: payout.organizationId,
      action: "expense.approved",
      entity: { type: "expense", id: claim.id },
      before: { status: claim.status },
      after: {
        status: "paying",
        payoutId: payout.id,
        approvalId,
        amountKes: payout.amountKes,
        selfApproval,
      },
    });
  });
}

/** Where a `paying` claim goes when its payout reaches `status`. */
const OUTCOMES: Partial<
  Record<
    Payout["status"],
    { readonly status: ExpenseStatus; readonly action: string }
  >
> = {
  paid: { status: "paid", action: "expense.paid" },
  failed: { status: "payout_failed", action: "expense.payout_failed" },
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
        .update(expenses)
        .set({
          status: outcome.status,
          ...(outcome.status === "paid" && {
            paidAt: payout.paidAt ?? new Date(),
          }),
        })
        .where(
          and(
            eq(expenses.id, payout.subjectId),
            eq(expenses.organizationId, payout.organizationId),
            eq(expenses.kind, "claim"),
            eq(expenses.payoutId, payout.id),
            eq(expenses.status, "paying"),
          ),
        )
        .returning({ id: expenses.id, paidAt: expenses.paidAt }),
    );
    if (!moved) return;
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: SYSTEM,
      organizationId: payout.organizationId,
      action: outcome.action,
      entity: { type: "expense", id: moved.id },
      before: { status: "paying" },
      after: {
        status: outcome.status,
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
  });
}

export const claimPayoutHooks: SubjectHooks = {
  approved: approveClaim,
  changed: followPayout,
};
