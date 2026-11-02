import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, Forbidden } from "../../errors.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
} from "../approval/passkeys.js";
import {
  memberships,
  organizations,
  payouts,
  payrollRuns,
  platformSettings,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { isAllowlisted } from "../allowlist/allowlist.js";
import { startApproval, verifyApproval } from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { fromMicro } from "../paycrest/amounts.js";
import { ledgerBalance, reservedForPayouts } from "../wallet/ledger.js";
import { payoutIntentHash } from "./intent.js";
import { PayoutRejected } from "./payout-errors.js";
import { approveSubjects } from "./subjects.js";

type ApproveDeps = DatabaseService | AuditLog | ApprovalSettings;

const reject = (reason: PayoutRejected["reason"], message: string) =>
  Effect.fail(new PayoutRejected({ reason, message }));

function requireActiveAdmin(
  tx: Transaction,
  organizationId: string,
  userId: string,
): Effect.Effect<void, PayoutRejected | DatabaseError> {
  return query(() =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.role, "admin"),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([membership]) =>
      membership
        ? Effect.void
        : reject("not_an_admin", "Only an admin of this company can pay."),
    ),
  );
}

function awaitingBatch(
  tx: Transaction,
  organizationId: string,
  payoutIds: readonly string[],
  lock: boolean,
): Effect.Effect<Payout[], PayoutRejected | DatabaseError> {
  return Effect.gen(function* () {
    if (payoutIds.length === 0) {
      return yield* reject("empty_batch", "Choose something to pay.");
    }
    const select = tx
      .select()
      .from(payouts)
      .where(
        and(
          eq(payouts.organizationId, organizationId),
          inArray(payouts.id, [...payoutIds]),
        ),
      );
    const batch = yield* query(() => (lock ? select.for("update") : select));
    if (
      batch.length !== new Set(payoutIds).size ||
      batch.some((payout) => payout.status !== "awaiting_approval")
    ) {
      return yield* reject(
        "not_awaiting_approval",
        "Some of these payments are no longer waiting for approval.",
      );
    }
    if (new Set(batch.map((payout) => payout.payrollRunId)).size > 1) {
      return yield* reject("mixed_batch", "A payroll run is paid on its own.");
    }
    if (
      batch.length > 1 &&
      batch.some((payout) => payout.subjectType === "withdrawal")
    ) {
      return yield* reject(
        "mixed_batch",
        "A withdrawal is approved on its own.",
      );
    }
    return batch;
  });
}

export interface ApprovalRequest extends ApprovalChallenge {
  readonly totalKes: bigint;
  readonly totalMaxDebitUsdc: bigint;
}

/**
 * Step 3 of Approve & pay (spec §6.7): a passkey challenge for exactly
 * these payouts, as they are now. What the admin sees and signs is the
 * KES each recipient gets and the most USDC that can leave the wallet.
 */
export function requestPayoutApproval(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly payoutIds: readonly string[];
}): Effect.Effect<
  ApprovalRequest,
  PayoutRejected | Forbidden | DatabaseError,
  ApproveDeps
> {
  const scope = {
    organizationId: input.organizationId,
    userId: input.userId,
    role: "admin" as const,
  };
  return Effect.gen(function* () {
    const batch = yield* withScope(scope, (tx) =>
      requireActiveAdmin(tx, input.organizationId, input.userId).pipe(
        Effect.zipRight(
          awaitingBatch(tx, input.organizationId, input.payoutIds, false),
        ),
      ),
    );
    const challenge = yield* startApproval({
      organizationId: input.organizationId,
      userId: input.userId,
      purpose: "approve_payouts",
      intentHash: payoutIntentHash(input.organizationId, batch),
      payoutIds: batch.map((payout) => payout.id),
    });
    return {
      ...challenge,
      totalKes: batch.reduce((sum, payout) => sum + payout.amountKes, 0n),
      totalMaxDebitUsdc: batch.reduce(
        (sum, payout) => sum + payout.maxDebitUsdc,
        0n,
      ),
    };
  });
}

/** Start of today in Nairobi, where "today" for the daily cap is (§7.4). */
const startOfNairobiDay = sql`(date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi')`;

/**
 * The daily cap covers claims, floats and bills (§7.4). A withdrawal moves
 * the company's own money to its own allowlisted address, so it neither
 * needs room under the cap nor uses any; the per-transaction cap still
 * bounds it.
 */
function checkCaps(
  tx: Transaction,
  organizationId: string,
  batch: readonly Payout[],
  dailyCapKes: bigint,
): Effect.Effect<void, PayoutRejected | DatabaseError> {
  return Effect.gen(function* () {
    if (batch.every((payout) => payout.subjectType === "withdrawal")) return;
    const batchKes = batch.reduce((sum, payout) => sum + payout.amountKes, 0n);
    const payrollRunId = batch[0]?.payrollRunId ?? null;
    const counted = notInArray(payouts.status, ["awaiting_approval", "failed"]);

    if (payrollRunId) {
      const [run] = yield* query(() =>
        tx
          .select({ capKes: payrollRuns.capKes })
          .from(payrollRuns)
          .where(eq(payrollRuns.id, payrollRunId))
          .limit(1),
      );
      if (!run) {
        return yield* reject("payroll_cap", "That payroll run doesn't exist.");
      }
      const [paid] = yield* query(() =>
        tx
          .select({
            total: sql<string>`coalesce(sum(${payouts.amountKes}), 0)::text`,
          })
          .from(payouts)
          .where(and(eq(payouts.payrollRunId, payrollRunId), counted)),
      );
      if (BigInt(paid?.total ?? "0") + batchKes > run.capKes) {
        return yield* reject(
          "payroll_cap",
          "This payroll run is over its cap: the active salaries plus the margin.",
        );
      }
      return;
    }

    const [today] = yield* query(() =>
      tx
        .select({
          total: sql<string>`coalesce(sum(${payouts.amountKes}), 0)::text`,
        })
        .from(payouts)
        .where(
          and(
            eq(payouts.organizationId, organizationId),
            isNull(payouts.payrollRunId),
            ne(payouts.subjectType, "withdrawal"),
            counted,
            gte(payouts.approvedAt, startOfNairobiDay),
          ),
        ),
    );
    if (BigInt(today?.total ?? "0") + batchKes > dailyCapKes) {
      return yield* reject(
        "daily_cap",
        "This would take today's payouts over the company's daily cap.",
      );
    }
  });
}

/**
 * Step 4 of Approve & pay (spec §6.7, §7): verifies the admin's passkey,
 * then, holding the company wallet's row lock so concurrent approvals queue,
 * checks the approval still matches the payouts, both pause flags, the
 * balance net of what's already promised, and the right cap. Only then are
 * the payouts approved; nothing is ordered or sent here.
 */
export function approvePayouts(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}): Effect.Effect<
  Payout[],
  PayoutRejected | Forbidden | DatabaseError,
  ApproveDeps
> {
  const { organizationId, userId } = input;
  const scope = { organizationId, userId, role: "admin" as const };

  return Effect.gen(function* () {
    const approval = yield* verifyApproval({
      ...input,
      purpose: "approve_payouts",
    });
    const audit = yield* AuditLog;

    return yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        yield* requireActiveAdmin(tx, organizationId, userId);
        const [wallet] = yield* query(() =>
          tx
            .select({ id: wallets.id })
            .from(wallets)
            .where(
              and(
                eq(wallets.organizationId, organizationId),
                eq(wallets.status, "active"),
              ),
            )
            .for("update"),
        );
        if (!wallet) {
          return yield* reject("no_wallet", "This company has no wallet yet.");
        }

        const batch = yield* awaitingBatch(
          tx,
          organizationId,
          approval.payoutIds,
          true,
        );
        if (payoutIntentHash(organizationId, batch) !== approval.intentHash) {
          return yield* reject(
            "approval_mismatch",
            "These payments changed after you confirmed. Confirm again.",
          );
        }

        for (const payout of batch) {
          if (
            payout.recipient.method === "usdc" &&
            !(yield* isAllowlisted(
              tx,
              organizationId,
              payout.recipient.address,
            ))
          ) {
            return yield* reject(
              "not_allowlisted",
              "A USDC address in this batch is no longer on the allowlist.",
            );
          }
        }

        const [company] = yield* query(() =>
          tx
            .select({
              paused: organizations.payoutsPaused,
              dailyCapKes: organizations.dailyPayoutCapKes,
            })
            .from(organizations)
            .where(eq(organizations.id, organizationId)),
        );
        const [platform] = yield* query(() =>
          tx
            .select({ paused: platformSettings.payoutsPaused })
            .from(platformSettings)
            .limit(1),
        );
        if (!company || company.paused || (platform?.paused ?? true)) {
          return yield* reject(
            "paused",
            "Payouts are paused. Nothing was sent.",
          );
        }

        const needed = batch.reduce(
          (sum, payout) => sum + payout.maxDebitUsdc,
          0n,
        );
        const available =
          (yield* ledgerBalance(tx, wallet.id)) -
          (yield* reservedForPayouts(tx, wallet.id));
        if (available < needed) {
          return yield* Effect.fail(
            new PayoutRejected({
              reason: "insufficient_balance",
              message: `The wallet is short by ${fromMicro(needed - available)} USDC. Top up first.`,
              shortfallUsdc: needed - available,
            }),
          );
        }

        yield* checkCaps(tx, organizationId, batch, company.dailyCapKes);

        const approvedAt = new Date();
        const approved = yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: "approved",
              approvalId: approval.approvalId,
              approvedBy: userId,
              approvedAt,
            })
            .where(
              and(
                inArray(
                  payouts.id,
                  batch.map((payout) => payout.id),
                ),
                eq(payouts.status, "awaiting_approval"),
              ),
            )
            .returning(),
        );
        for (const payout of approved) {
          yield* audit.record(tx, {
            actor: { type: "user", id: userId },
            organizationId,
            action: "payout.approved",
            entity: { type: "payout", id: payout.id },
            after: {
              approvalId: approval.approvalId,
              amountKes: payout.amountKes,
              maxDebitUsdc: payout.maxDebitUsdc,
              batchSize: approved.length,
            },
          });
        }
        yield* approveSubjects(tx, approved);
        return approved;
      }),
    ).pipe(
      Effect.tapError((error) =>
        error instanceof PayoutRejected
          ? withScope(scope, (tx) =>
              audit.record(tx, {
                actor: { type: "user", id: userId },
                organizationId,
                action: "payout.approval_rejected",
                entity: { type: "approval", id: approval.approvalId },
                after: {
                  reason: error.reason,
                  payoutIds: approval.payoutIds,
                },
              }),
            )
          : Effect.void,
      ),
    );
  });
}
