import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { RecordFloatReturnFields } from "@expendi-business/shared";
import { formatKesAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, NotFound } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { FloatDetailView, FloatSummaryView } from "./views.js";
import { floatMovements, floats, payouts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { discardUnapprovedPayout } from "../payout/discard.js";
import {
  floatNotFound,
  readFloatDetail,
  readFloatSummary,
  visibleFloats,
} from "./views.js";

/**
 * Returns and closing (spec §6.22): the holder hands back what's left
 * outside the app, an admin records it, then closes the float. Neither
 * moves money through Expendi.
 *
 * A float closes only once nothing is left on it. When the rest isn't
 * coming back, the admin can still close it by giving a reason: what's
 * left is then written off as a `write_off` movement carrying the reason,
 * so the balance of every closed float is zero and the shortfall stays on
 * record. Nothing on its way to the holder can be closed over; a payment
 * still waiting for approval is withdrawn as the float closes.
 */

const CLOSED_BEFORE_APPROVAL =
  "The float was closed before this payment was approved. Nothing was sent.";

const floatClosed = new Conflict({ message: "This float is already closed." });

function lockOpenFloat(tx: Transaction, tenant: Tenant, floatId: string) {
  return Effect.gen(function* () {
    const [float] = yield* query(() =>
      tx
        .select({ id: floats.id, status: floats.status })
        .from(floats)
        .where(and(visibleFloats(tenant), eq(floats.id, floatId)))
        .for("update"),
    );
    if (!float) return yield* Effect.fail(floatNotFound);
    if (float.status !== "open") return yield* Effect.fail(floatClosed);
    const summary = yield* readFloatSummary(tx, tenant, floatId);
    if (!summary) return yield* Effect.fail(floatNotFound);
    return summary;
  });
}

/** Records cash the holder handed back; at most what's left on the float. */
export function recordFloatReturn(
  tenant: Tenant,
  floatId: string,
  fields: RecordFloatReturnFields,
): Effect.Effect<
  FloatDetailView,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const note = fields.note ?? null;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const float = yield* lockOpenFloat(tx, tenant, floatId);
      if (fields.amountKes > float.leftKes) {
        return yield* Effect.fail(
          new Conflict({
            message:
              float.leftKes > 0n
                ? `Only ${formatKesAmount(float.leftKes)} is left on this float.`
                : "Nothing is left on this float to hand back.",
          }),
        );
      }
      const [movement] = yield* query(() =>
        tx
          .insert(floatMovements)
          .values({
            organizationId: tenant.organizationId,
            floatId,
            type: "return",
            status: "recorded",
            amountKes: fields.amountKes,
            note,
            recordedBy: tenant.userId,
          })
          .returning({ id: floatMovements.id }),
      );
      if (!movement) return yield* Effect.dieMessage("return wrote no row");
      yield* audit.record(tx, {
        actor: { type: "user", id: tenant.userId },
        organizationId: tenant.organizationId,
        action: "float.return_recorded",
        entity: { type: "float_movement", id: movement.id },
        after: {
          floatId,
          amountKes: fields.amountKes,
          note,
          leftBeforeKes: float.leftKes,
          leftAfterKes: float.leftKes - fields.amountKes,
        },
      });
      return yield* readFloatDetail(tx, tenant, floatId);
    }),
  );
}

interface PendingPayment {
  readonly movementId: string;
  readonly amountKes: bigint;
  readonly payoutId: string;
  readonly awaitingApproval: boolean;
}

function pendingPaymentsOf(
  tx: Transaction,
  floatId: string,
): Effect.Effect<readonly PendingPayment[], DatabaseError> {
  return query(() =>
    tx
      .select({
        movementId: floatMovements.id,
        amountKes: floatMovements.amountKes,
        payoutId: payouts.id,
        payoutStatus: payouts.status,
      })
      .from(floatMovements)
      .innerJoin(payouts, eq(payouts.id, floatMovements.payoutId))
      .where(
        and(
          eq(floatMovements.floatId, floatId),
          eq(floatMovements.status, "pending"),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        movementId: row.movementId,
        amountKes: row.amountKes,
        payoutId: row.payoutId,
        awaitingApproval: row.payoutStatus === "awaiting_approval",
      })),
    ),
  );
}

/** The closing rule: nothing left, or a reason to write off what is. */
function checkClosable(
  float: FloatSummaryView,
  pending: readonly PendingPayment[],
  writeOffReason: string | null,
): Effect.Effect<void, Conflict | BadRequest> {
  const onItsWay = pending.find((payment) => !payment.awaitingApproval);
  if (onItsWay) {
    return Effect.fail(
      new Conflict({
        message: `${formatKesAmount(onItsWay.amountKes)} is still on its way to the holder. Close the float once it has arrived or failed.`,
      }),
    );
  }
  if (float.leftKes > 0n && writeOffReason === null) {
    return Effect.fail(
      new Conflict({
        message: `${formatKesAmount(float.leftKes)} is still on this float. Record what's handed back first, or give a reason to write it off.`,
        details: { leftKes: float.leftKes.toString() },
      }),
    );
  }
  if (float.leftKes <= 0n && writeOffReason !== null) {
    return Effect.fail(
      new BadRequest({
        message: "Nothing is left on this float to write off.",
      }),
    );
  }
  return Effect.void;
}

/**
 * Closes a float (spec §6.22). Checked under the float's lock, once before
 * withdrawing any payment still waiting for approval and again after, so a
 * refused close changes nothing.
 */
export function closeFloat(
  tenant: Tenant,
  floatId: string,
  input: { readonly writeOffReason: string | null },
): Effect.Effect<
  FloatDetailView,
  Conflict | BadRequest | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { writeOffReason } = input;
  return Effect.gen(function* () {
    const awaiting = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const float = yield* lockOpenFloat(tx, tenant, floatId);
        const pending = yield* pendingPaymentsOf(tx, floatId);
        yield* checkClosable(float, pending, writeOffReason);
        return pending;
      }),
    );
    // Withdrawn outside the float's lock: approval takes a payout's lock
    // before its float's, so taking them the other way round could deadlock.
    yield* Effect.forEach(
      awaiting,
      (payment) =>
        withScope(tenant, (tx) =>
          discardUnapprovedPayout(tx, {
            organizationId: tenant.organizationId,
            payoutId: payment.payoutId,
            reason: CLOSED_BEFORE_APPROVAL,
            actor: { type: "user", id: tenant.userId },
          }),
        ),
      { discard: true },
    );

    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const float = yield* lockOpenFloat(tx, tenant, floatId);
        const pending = yield* pendingPaymentsOf(tx, floatId);
        if (pending.length > 0) {
          return yield* Effect.fail(
            new Conflict({
              message:
                "A payment to this float started while closing it. Check the float and try again.",
            }),
          );
        }
        yield* checkClosable(float, pending, writeOffReason);
        const writtenOffKes = writeOffReason === null ? 0n : float.leftKes;
        if (writeOffReason !== null) {
          yield* query(() =>
            tx.insert(floatMovements).values({
              organizationId: tenant.organizationId,
              floatId,
              type: "write_off",
              status: "recorded",
              amountKes: writtenOffKes,
              note: writeOffReason,
              recordedBy: tenant.userId,
            }),
          );
        }
        const closedAt = new Date();
        yield* query(() =>
          tx
            .update(floats)
            .set({ status: "closed", closedAt, closedBy: tenant.userId })
            .where(eq(floats.id, floatId)),
        );
        yield* audit.record(tx, {
          actor: { type: "user", id: tenant.userId },
          organizationId: tenant.organizationId,
          action: "float.closed",
          entity: { type: "float", id: floatId },
          before: { status: "open", leftKes: float.leftKes },
          after: {
            status: "closed",
            closedAt,
            writtenOffKes,
            writeOffReason,
            withdrawnMovementIds: awaiting.map((payment) => payment.movementId),
          },
        });
        return yield* readFloatDetail(tx, tenant, floatId);
      }),
    );
  });
}
