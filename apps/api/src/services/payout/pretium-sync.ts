import { and, eq, sql } from "drizzle-orm";
import { Effect, Either } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type {
  PretiumError,
  PretiumTransaction,
} from "../pretium/pretium-client.js";
import type { SyncOutcome } from "./sync.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { Pretium } from "../pretium/pretium-client.js";
import { lockPayout } from "./guards.js";
import { applyPayoutOutcome } from "./subjects.js";
import { FUNDING_STUCK_MS, PAYING_STUCK_MS } from "./sync.js";

/**
 * Brings Pretium cash-outs in line with Pretium's status endpoint. The
 * signed callback, the minute job and staff's re-fetch all end here, always
 * with a status freshly read from Pretium, never a callback body.
 *
 * This only reads Pretium and updates our records: it never sends USDC and
 * never asks Pretium to pay or refund. Those happen once each, in
 * `pretium-fund.ts`, which nothing reachable from a webhook or a staff
 * route may import.
 */

const ACTOR = { type: "system", id: "pretium-sync" } as const;

/** Pretium paid the shillings. */
const PAID = new Set(["COMPLETE", "COMPLETED"]);
/** Pretium won't pay: the continuation asks for the refund. */
export const PRETIUM_UNPAID = new Set(["FAILED", "REVERSED"]);
/** Pretium sent the USDC back without being asked. */
const REFUNDED = "REFUNDED";

/** A refund not credited this long after it was asked for: a person looks. */
export const REFUND_ARRIVAL_STUCK_MS = 30 * 60_000;

export const isPretiumPaid = (status: string | null): boolean =>
  status !== null && PAID.has(status.toUpperCase());

export interface PretiumSyncResult {
  readonly outcome: SyncOutcome;
  /** Pretium's status as last saved, after this sync. */
  readonly providerStatus: string | null;
  /** Set when Pretium's status couldn't be read: nothing was judged on it. */
  readonly statusError: PretiumError | null;
}

interface Transition {
  readonly status: Payout["status"];
  readonly action: string;
  readonly reason?: string;
}

const review = (reason: string): Transition => ({
  status: "needs_review",
  action: "payout.needs_review",
  reason,
});

/**
 * Whether Pretium's decimal amount ("1000", "1000.00") is exactly
 * `shillings`, compared as digits: anything else, unparseable included,
 * isn't.
 */
function isExactly(reported: string, shillings: bigint): boolean {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(reported.trim());
  if (!parts?.[1]) return false;
  return BigInt(parts[1]) === shillings && /^0*$/.test(parts[2] ?? "");
}

const fundedLongerThan = (payout: Payout, ms: number, now: number) =>
  payout.fundingStartedAt !== null &&
  now - payout.fundingStartedAt.getTime() > ms;

/** USDC credited back to the company for this payout, in base units. */
function refundedAmount(
  tx: Transaction,
  payoutId: string,
): Effect.Effect<bigint | null, DatabaseError> {
  return query(() =>
    tx
      .select({
        total: sql<string | null>`sum(${walletTransactions.usdcAmount})`,
        credits: sql<string>`count(*)`,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.payoutId, payoutId),
          eq(walletTransactions.type, "refund"),
        ),
      ),
  ).pipe(
    Effect.map(([row]) =>
      row && Number(row.credits) > 0 ? BigInt(row.total ?? "0") : null,
    ),
  );
}

/**
 * Where a `paying` Pretium cash-out goes next, given Pretium's transaction
 * (null when there is none to read) and what has been refunded so far.
 */
function nextFor(input: {
  readonly payout: Payout;
  readonly transaction: PretiumTransaction | null;
  readonly refundRequestedAt: Date | null;
  readonly refunded: bigint | null;
  readonly now: number;
}): Transition | null {
  const { payout, transaction, refundRequestedAt, refunded, now } = input;
  const status = transaction?.status.toUpperCase() ?? null;

  if (
    transaction?.transactionHash != null &&
    transaction.transactionHash !== payout.txHash?.toLowerCase()
  ) {
    return review(
      `Pretium's transaction ${transaction.transactionCode} is for transfer ${transaction.transactionHash}, not this payout's ${payout.txHash ?? "(none)"}. Check with Pretium before doing anything.`,
    );
  }

  if (refundRequestedAt !== null) {
    if (isPretiumPaid(status)) {
      return review(
        `Pretium reports transaction ${payout.providerOrderId ?? ""} ${status ?? ""} although its refund was asked for. Check with Pretium whether the shillings were paid or the USDC refunded before doing anything.`,
      );
    }
    const sent = payout.amountToTransferUsdc ?? 0n;
    if (refunded !== null) {
      return refunded >= sent
        ? {
            status: "failed",
            action: "payout.failed",
            reason:
              "The cash-out didn't go through. The USDC is back in the company wallet.",
          }
        : review(
            `Pretium refunded ${refunded} of the ${sent} USDC base units sent. Find the rest with Pretium before doing anything.`,
          );
    }
    if (now - refundRequestedAt.getTime() > REFUND_ARRIVAL_STUCK_MS) {
      return review(
        `The refund asked of Pretium hasn't reached the company's wallet${payout.refundTxHash ? ` (Pretium named ${payout.refundTxHash})` : ""}. The USDC may still be with Pretium: check with them before doing anything.`,
      );
    }
    return null;
  }

  if (isPretiumPaid(status)) {
    // The shillings Pretium was told to pay: `pay` sends whole shillings.
    const shillings = payout.amountKes / 100n;
    const reported = transaction?.amount ?? null;
    if (reported !== null && !isExactly(reported, shillings)) {
      return review(
        `Pretium reports transaction ${payout.providerOrderId ?? ""} ${status ?? ""} for KES ${reported}, but this cash-out is KES ${shillings}. Check with Pretium what was paid before doing anything.`,
      );
    }
    return { status: "paid", action: "payout.paid" };
  }
  if (fundedLongerThan(payout, PAYING_STUCK_MS, now)) {
    return review(
      `The USDC was sent to Pretium but the cash-out still isn't paid (${status ?? "no transaction yet"}). Check with Pretium before doing anything.`,
    );
  }
  return null;
}

/** The payout behind a Pretium transaction code, from any company. */
export function payoutForPretiumTransaction(
  transactionCode: string,
): Effect.Effect<
  { readonly payout_id: string; readonly organization_id: string } | null,
  DatabaseError,
  DatabaseService
> {
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<{ payout_id: string; organization_id: string }>(
        sql`SELECT payout_id, organization_id FROM payout_by_pretium_transaction(${transactionCode})`,
      ),
    ),
  ).pipe(Effect.map(({ rows }) => rows[0] ?? null));
}

/**
 * Applies Pretium's view of a cash-out to it, under its row lock. Status
 * only moves forward, so a duplicate or stale callback changes nothing, and
 * `paid`, `failed` and `needs_review` are never touched.
 *
 * - `funding` too long: a person looks (the send's outcome was never saved).
 * - `paying`: Pretium's COMPLETE is `paid`; FAILED and REVERSED are only
 *   saved, for the continuation to ask for the refund; REFUNDED records
 *   that Pretium refunded by itself. Once a refund is asked for, it is
 *   `failed` when all of it is credited back, and `needs_review` when less
 *   came back, none came in 30 minutes, or Pretium then reports it paid.
 * - A status that can't be read changes nothing judged on it.
 */
export function syncPretiumPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
  readonly source: "webhook" | "reconcile" | "staff";
}): Effect.Effect<
  PretiumSyncResult,
  DatabaseError,
  DatabaseService | AuditLog | Pretium
> {
  const { organizationId, payoutId } = input;
  const scope = { organizationId };
  return Effect.gen(function* () {
    const pretium = yield* Pretium;
    const [seen] = yield* withScope(scope, (tx) =>
      query(() => tx.select().from(payouts).where(eq(payouts.id, payoutId))),
    );
    if (seen?.provider !== "pretium") {
      return yield* Effect.dieMessage(
        `payout ${payoutId} isn't a Pretium cash-out`,
      );
    }

    const code = seen.status === "paying" ? seen.providerOrderId : null;
    const read =
      code === null ? null : yield* Effect.either(pretium.status(code));
    const statusError = read && Either.isLeft(read) ? read.left : null;
    const transaction = read && Either.isRight(read) ? read.right : null;
    if (statusError) {
      console.warn(
        `[pretium-sync] status of ${code ?? ""} for payout ${payoutId} unavailable: ${statusError.code}`,
      );
    }

    return yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const locked = yield* lockPayout(tx, payoutId);
        if (!locked) {
          return yield* Effect.dieMessage(`payout ${payoutId} vanished`);
        }
        const unchanged: PretiumSyncResult = {
          outcome: { changed: false },
          providerStatus: locked.providerStatus,
          statusError,
        };
        const now = Date.now();

        if (locked.status === "funding") {
          if (!fundedLongerThan(locked, FUNDING_STUCK_MS, now)) {
            return unchanged;
          }
          const moved = yield* move(
            tx,
            locked,
            review(
              "Funding started but no outcome was recorded. Check the chain and Pretium before doing anything.",
            ),
            {},
            input.source,
          );
          return { ...unchanged, outcome: moved };
        }
        if (locked.status !== "paying") return unchanged;
        if (statusError) {
          if (!fundedLongerThan(locked, PAYING_STUCK_MS, now)) return unchanged;
          const moved = yield* move(
            tx,
            locked,
            review(
              `Pretium hasn't returned transaction ${locked.providerOrderId ?? ""} (${statusError.code}) and the cash-out still isn't paid. Check with Pretium before doing anything.`,
            ),
            { providerCheckedAt: new Date(now) },
            input.source,
          );
          return { ...unchanged, outcome: moved };
        }
        // The transaction read before the lock is only used for the code
        // the payout still has.
        const current =
          transaction?.transactionCode === locked.providerOrderId
            ? transaction
            : null;

        const status = current?.status ?? locked.providerStatus;
        const saved: Partial<typeof payouts.$inferInsert> = {
          providerCheckedAt: new Date(now),
          ...(current && {
            providerStatus: current.status,
            ...(current.receiptNumber !== null && {
              providerReference: current.receiptNumber,
            }),
          }),
        };

        let refundRequestedAt = locked.refundRequestedAt;
        if (
          refundRequestedAt === null &&
          current?.status.toUpperCase() === REFUNDED
        ) {
          refundRequestedAt = new Date(now);
          saved.refundRequestedAt = refundRequestedAt;
          yield* audit.record(tx, {
            actor: ACTOR,
            organizationId,
            action: "payout.refund_reported",
            entity: { type: "payout", id: payoutId },
            after: {
              status: locked.status,
              pretiumStatus: current.status,
              source: input.source,
            },
          });
        }

        const refunded =
          refundRequestedAt === null
            ? null
            : yield* refundedAmount(tx, payoutId);
        const transition = nextFor({
          payout: locked,
          transaction: current,
          refundRequestedAt,
          refunded,
          now,
        });

        if (!transition) {
          yield* query(() =>
            tx.update(payouts).set(saved).where(eq(payouts.id, payoutId)),
          );
          return { ...unchanged, providerStatus: status };
        }
        const moved = yield* move(
          tx,
          locked,
          transition,
          {
            ...saved,
            ...(transition.status === "paid" && { paidAt: new Date(now) }),
          },
          input.source,
          current,
        );
        return { ...unchanged, outcome: moved, providerStatus: status };
      }),
    );
  });

  function move(
    tx: Transaction,
    from: Payout,
    transition: Transition,
    changes: Partial<typeof payouts.$inferInsert>,
    source: string,
    transaction: PretiumTransaction | null = null,
  ): Effect.Effect<SyncOutcome, DatabaseError, AuditLog> {
    return Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [updated] = yield* query(() =>
        tx
          .update(payouts)
          .set({
            ...changes,
            status: transition.status,
            ...(transition.reason && { failureReason: transition.reason }),
          })
          .where(and(eq(payouts.id, from.id), eq(payouts.status, from.status)))
          .returning(),
      );
      if (!updated) {
        return yield* Effect.dieMessage(
          `payout ${from.id} changed under its lock`,
        );
      }
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: from.organizationId,
        action: transition.action,
        entity: { type: "payout", id: from.id },
        before: { status: from.status },
        after: {
          status: updated.status,
          source,
          ...(transaction && { pretiumStatus: transaction.status }),
          ...(transition.reason && { reason: transition.reason }),
          ...(updated.providerReference && {
            providerReference: updated.providerReference,
          }),
        },
      });
      yield* applyPayoutOutcome(tx, updated);
      return { changed: true, from: from.status, to: updated.status } as const;
    });
  }
}
