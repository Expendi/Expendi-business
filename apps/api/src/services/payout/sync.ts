import { and, eq, sql } from "drizzle-orm";
import { Cause, Effect, Either, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type {
  PaycrestError,
  PaycrestOrder,
} from "../paycrest/paycrest-client.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { lockPayout } from "./guards.js";

/**
 * Brings payouts in line with Paycrest (spec §6.8). Both the signed webhook
 * and the minute reconciliation job end here, always with an order freshly
 * fetched from Paycrest, never a webhook body. This only reads Paycrest and
 * updates our records: it never creates an order or sends money.
 */

const ACTOR = { type: "system", id: "paycrest-sync" } as const;

/** The payout reached the recipient (Paycrest says to notify at validated). */
const PAID = new Set(["validated", "settling", "settled"]);
/** Paycrest has our deposit and is working on it. */
const RECEIVED = new Set([
  "deposited",
  "pending",
  "fulfilling",
  "fulfilled",
  "refunding",
]);
/** Paycrest gave up on an order whose deposit it never received. */
const NEVER_FUNDED = new Set(["expired", "cancelled"]);

/** No result recorded this long after funding started: a person looks. */
export const FUNDING_STUCK_MS = 10 * 60_000;
/** Still not paid this long after funding started: a person looks. */
export const PAYING_STUCK_MS = 2 * 60 * 60_000;
/** An order request still unanswered after this is treated as unknown. */
export const ORDER_REQUEST_STUCK_MS = 2 * 60_000;
/** An approval that never started funding is released after this. */
export const APPROVAL_LAPSE_MS = 15 * 60_000;

export type SyncOutcome =
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly from: Payout["status"];
      readonly to: Payout["status"];
    };

interface Transition {
  readonly status: Payout["status"];
  readonly action: string;
  readonly reason?: string;
}

function fundedLongerThan(payout: Payout, ms: number, now: number): boolean {
  return (
    payout.fundingStartedAt !== null &&
    now - payout.fundingStartedAt.getTime() > ms
  );
}

function nextFor(
  payout: Payout,
  order: PaycrestOrder,
  now: number,
): Transition | null {
  const status = order.status.toLowerCase();
  switch (payout.status) {
    case "paying":
      if (PAID.has(status)) return { status: "paid", action: "payout.paid" };
      if (status === "refunded") {
        return {
          status: "failed",
          action: "payout.failed",
          reason:
            "Paycrest refunded the order. The USDC returns to the company wallet.",
        };
      }
      if (NEVER_FUNDED.has(status)) {
        return {
          status: "needs_review",
          action: "payout.needs_review",
          reason: `Paycrest marked the order ${status} after the USDC was sent.`,
        };
      }
      if (fundedLongerThan(payout, PAYING_STUCK_MS, now)) {
        return {
          status: "needs_review",
          action: "payout.needs_review",
          reason: `The USDC was sent but Paycrest still reports the order ${status}. Check with Paycrest before doing anything.`,
        };
      }
      return null;
    case "funding":
      if (PAID.has(status) || RECEIVED.has(status) || status === "refunded") {
        return { status: "paying", action: "payout.paying" };
      }
      if (NEVER_FUNDED.has(status)) {
        return {
          status: "needs_review",
          action: "payout.needs_review",
          reason: `Funding started but Paycrest marked the order ${status}. Check the chain before doing anything.`,
        };
      }
      if (fundedLongerThan(payout, FUNDING_STUCK_MS, now)) {
        return {
          status: "needs_review",
          action: "payout.needs_review",
          reason:
            "Funding started but no outcome was recorded. Check the chain before doing anything.",
        };
      }
      return null;
    case "order_created": {
      // Funding never started, so nothing was sent.
      const windowClosed =
        !payout.depositValidUntil || payout.depositValidUntil.getTime() < now;
      if (
        NEVER_FUNDED.has(status) ||
        (status === "initiated" && windowClosed)
      ) {
        return {
          status: "failed",
          action: "payout.failed",
          reason: "The order expired before funding. Nothing was sent.",
        };
      }
      if (status !== "initiated") {
        return {
          status: "needs_review",
          action: "payout.needs_review",
          reason: `Paycrest reports ${status} for an order we never funded.`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function recordFundingDebit(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, DatabaseError> {
  const amount = payout.amountToTransferUsdc;
  if (amount === null) {
    return Effect.dieMessage(`payout ${payout.id} has no transfer amount`);
  }
  return query(() =>
    tx
      .insert(walletTransactions)
      .values({
        organizationId: payout.organizationId,
        walletId: payout.walletId,
        type: "payout",
        usdcAmount: -amount,
        txHash: payout.txHash,
        counterpartyAddress: payout.depositAddress?.toLowerCase() ?? null,
        payoutId: payout.id,
      })
      .onConflictDoNothing(),
  ).pipe(Effect.asVoid);
}

/**
 * Applies Paycrest's view of `order` to its payout, under the payout's row
 * lock. Status only moves forward, so a duplicate or stale delivery changes
 * nothing. `touch` records the check even when nothing changed, so the
 * reconciliation job rotates through payouts.
 */
export function syncPayoutOrder(input: {
  readonly organizationId: string;
  readonly payoutId: string;
  readonly order: PaycrestOrder;
  readonly source: "webhook" | "reconcile";
  readonly touch: boolean;
}): Effect.Effect<SyncOutcome, DatabaseError, DatabaseService | AuditLog> {
  const { organizationId, payoutId, order } = input;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [payout] = yield* query(() =>
        tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update"),
      );
      if (
        payout?.providerOrderId !== order.id ||
        order.reference !== payout.id ||
        (order.direction && order.direction !== "offramp")
      ) {
        console.error(
          `[paycrest-sync] order ${order.id} doesn't match payout ${payoutId}; ignored`,
        );
        return { changed: false } as const;
      }

      const now = Date.now();
      let current = payout;
      let from: Payout["status"] | null = null;
      // A deposit Paycrest has seen can settle in the same sync.
      for (let step = 0; step < 2; step += 1) {
        const transition = nextFor(current, order, now);
        if (!transition) break;
        from ??= current.status;
        if (current.status === "funding" && transition.status === "paying") {
          yield* recordFundingDebit(tx, current);
        }
        const [updated] = yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: transition.status,
              providerStatus: order.status,
              providerCheckedAt: new Date(now),
              ...(transition.reason && { failureReason: transition.reason }),
              ...(transition.status === "paid" && {
                paidAt: new Date(now),
                providerReference: order.paymentReference ?? null,
              }),
            })
            .where(
              and(eq(payouts.id, payoutId), eq(payouts.status, current.status)),
            )
            .returning(),
        );
        if (!updated) {
          return yield* Effect.dieMessage(
            `payout ${payoutId} changed under its lock`,
          );
        }
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: transition.action,
          entity: { type: "payout", id: payoutId },
          before: { status: current.status },
          after: {
            status: updated.status,
            paycrestStatus: order.status,
            source: input.source,
            ...(transition.reason && { reason: transition.reason }),
            ...(updated.providerReference && {
              providerReference: updated.providerReference,
            }),
          },
        });
        current = updated;
      }

      if (from) return { changed: true, from, to: current.status } as const;
      if (input.touch || payout.providerStatus !== order.status) {
        yield* query(() =>
          tx
            .update(payouts)
            .set({
              providerStatus: order.status,
              providerCheckedAt: new Date(now),
            })
            .where(eq(payouts.id, payoutId)),
        );
      }
      return { changed: false } as const;
    }),
  );
}

interface PayoutRef extends Record<string, unknown> {
  readonly payout_id: string;
  readonly organization_id: string;
}

/** The payout behind a Paycrest order ID, from any company. */
export function payoutForOrder(
  orderId: string,
): Effect.Effect<PayoutRef | null, DatabaseError, DatabaseService> {
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<PayoutRef>(
        sql`SELECT payout_id, organization_id FROM payout_by_provider_order(${orderId})`,
      ),
    ),
  ).pipe(Effect.map(({ rows }) => rows[0] ?? null));
}

/**
 * Settles what an approval left behind without an order: never sends, never
 * orders. An approval that never requested an order is released; a request
 * whose answer never came is for a person to check.
 */
function settleOrderlessApproval(
  payout: Payout,
  now: number,
): Effect.Effect<boolean, DatabaseError, DatabaseService | AuditLog> {
  let transition: Transition | null = null;
  if (
    !payout.orderRequestedAt &&
    payout.approvedAt &&
    now - payout.approvedAt.getTime() > APPROVAL_LAPSE_MS
  ) {
    transition = {
      status: "failed",
      action: "payout.failed",
      reason: "Funding never started after approval. Nothing was sent.",
    };
  } else if (
    payout.orderRequestedAt &&
    now - payout.orderRequestedAt.getTime() > ORDER_REQUEST_STUCK_MS
  ) {
    transition = {
      status: "needs_review",
      action: "payout.needs_review",
      reason: `Paycrest may have created an order. Check Paycrest for reference ${payout.id}; nothing was sent.`,
    };
  }
  const settled = transition;
  if (!settled) return Effect.succeed(false);
  return withScope({ organizationId: payout.organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [updated] = yield* query(() =>
        tx
          .update(payouts)
          .set({
            status: settled.status,
            failureReason: settled.reason ?? null,
          })
          .where(
            and(
              eq(payouts.id, payout.id),
              eq(payouts.status, "approved"),
              payout.orderRequestedAt
                ? sql`${payouts.providerOrderId} IS NULL`
                : sql`${payouts.orderRequestedAt} IS NULL`,
            ),
          )
          .returning({ id: payouts.id }),
      );
      if (!updated) return false;
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: payout.organizationId,
        action: settled.action,
        entity: { type: "payout", id: payout.id },
        before: { status: "approved" },
        after: { status: settled.status, reason: settled.reason },
      });
      return true;
    }),
  );
}

/**
 * Settles a funded payout whose order Paycrest won't return: never sends,
 * never orders. Any fetch error, a 404 included (Paycrest 404s an order
 * while it refunds), is for a person only once the payout is past its
 * stuck threshold. Before that the error stands and the next run retries.
 */
function reviewUnfetchedOrder(
  payout: Payout,
  error: PaycrestError,
  now: number,
): Effect.Effect<
  boolean,
  DatabaseError | PaycrestError,
  DatabaseService | AuditLog
> {
  const stuck =
    (payout.status === "funding" &&
      fundedLongerThan(payout, FUNDING_STUCK_MS, now)) ||
    (payout.status === "paying" &&
      fundedLongerThan(payout, PAYING_STUCK_MS, now));
  if (!stuck) return Effect.fail(error);
  const settled: Transition = {
    status: "needs_review",
    action: "payout.needs_review",
    reason: `Paycrest hasn't returned the order (${error.code}) and no outcome was recorded. Check the chain before doing anything.`,
  };
  return withScope({ organizationId: payout.organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const locked = yield* lockPayout(tx, payout.id);
      if (locked?.status !== payout.status) return false;
      yield* query(() =>
        tx
          .update(payouts)
          .set({
            status: settled.status,
            providerCheckedAt: new Date(now),
            failureReason: settled.reason ?? null,
          })
          .where(eq(payouts.id, payout.id)),
      );
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: payout.organizationId,
        action: settled.action,
        entity: { type: "payout", id: payout.id },
        before: { status: payout.status },
        after: {
          status: settled.status,
          paycrestError: error.code,
          source: "reconcile",
          reason: settled.reason,
        },
      });
      return true;
    }),
  );
}

export interface ReconcileSummary {
  readonly checked: number;
  readonly changed: number;
  readonly errors: number;
}

/**
 * The minute job (spec §6.8): for each unfinished Paycrest payout, fetch
 * the order and sync it. Each payout is isolated: one failing to sync
 * doesn't stop the rest.
 */
export function reconcilePaycrestPayouts(
  maxRows = 50,
): Effect.Effect<
  ReconcileSummary,
  DatabaseError,
  DatabaseService | AuditLog | Paycrest
> {
  return Effect.gen(function* () {
    const paycrest = yield* Paycrest;
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM paycrest_payouts_to_reconcile(${maxRows})`,
        ),
      ),
    );

    let changed = 0;
    let errors = 0;
    for (const ref of rows) {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const [payout] = yield* withScope(
            { organizationId: ref.organization_id },
            (tx) =>
              query(() =>
                tx.select().from(payouts).where(eq(payouts.id, ref.payout_id)),
              ),
          );
          if (!payout) return false;
          if (!payout.providerOrderId) {
            return payout.status === "approved"
              ? yield* settleOrderlessApproval(payout, Date.now())
              : false;
          }
          const fetched = yield* Effect.either(
            paycrest.getOrder(payout.providerOrderId),
          );
          if (Either.isLeft(fetched)) {
            return yield* reviewUnfetchedOrder(
              payout,
              fetched.left,
              Date.now(),
            );
          }
          const outcome = yield* syncPayoutOrder({
            organizationId: ref.organization_id,
            payoutId: payout.id,
            order: fetched.right,
            source: "reconcile",
            touch: true,
          });
          return outcome.changed;
        }),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value) changed += 1;
      } else {
        errors += 1;
        console.error(
          `[reconcile-paycrest] payout ${ref.payout_id} failed to sync`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { checked: rows.length, changed, errors };
  });
}
