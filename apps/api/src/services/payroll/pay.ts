import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  PayeeChangeHold,
  PaymentDestination,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout, PayrollRun } from "../../db/schema/index.js";
import type { DatabaseError, Forbidden } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { ApprovalChallenge } from "../approval/passkeys.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { PaycrestError } from "../paycrest/paycrest-client.js";
import type { AmountTooSmall } from "../paycrest/quote.js";
import type { PayeeChangeConfirmation } from "../payees/payment-guard.js";
import type { PaymentCost, WalletCover } from "../payments/payment-approval.js";
import type { PayoutRejected } from "../payout/payout-errors.js";
import type {
  KesPayoutRequest,
  PayoutEngineDeps,
} from "../payout/payout-service.js";
import type { PayablePayrollPayment, PayrollNotPayable } from "./payable.js";
import type { PayrollRunDetailView } from "./runs.js";
import { payouts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { canonicalJson } from "../approval/passkeys.js";
import {
  challengePayouts,
  costOf,
  destinationOf,
  topUpConflict,
  walletCover,
} from "../payments/payment-approval.js";
import { discardUnapprovedPayout } from "../payout/discard.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
} from "../payout/payout-service.js";
import {
  payablePayrollRetry,
  payablePayrollRun,
  payrollPayoutRequests,
} from "./payable.js";
import { getPayrollRun } from "./runs.js";

/**
 * Approve & pay all, and retrying one person (spec §6.21). One passkey
 * approves the run's payouts through the payout engine, which checks the
 * run's cap (its salaries plus the margin, spec §7.4) along with every
 * other guard. Each person is their own payout, or several for a salary
 * above Paycrest's largest order (`split.ts`), so a failure touches no one
 * else, and a retry pays only that person's parts not yet paid.
 *
 * The bills and the run move with their payouts in the engine's own
 * transactions (`bills/bill-payout-hooks.ts`, `run-status.ts`).
 */

export type PayrollPaymentError =
  | PayoutRejected
  | PaycrestError
  | AmountTooSmall
  | Conflict
  | NotFound
  | Forbidden
  | DatabaseError;

const approvalNotFound = new NotFound({
  message: "That payment wasn't found. Start Approve & pay again.",
});

const REPLACED =
  "Replaced before approval: the run, the person's pay or their payment details changed. Nothing was sent.";

const partKey = (billId: string, part: number) => `${billId}:${part}`;

/** The payroll seam's refusals, as the admin sees them. */
export function payrollNotPayableAsClientError(
  error: PayrollNotPayable,
): Effect.Effect<never, NotFound | Conflict | DatabaseError> {
  switch (error._tag) {
    case "NotFound":
    case "Conflict":
    case "DatabaseError":
      return Effect.fail(error);
    case "BillNotPayable":
      return Effect.fail(
        new Conflict({
          message: error.message,
          details: { billId: error.billId, reason: error.reason },
        }),
      );
    case "PayeeNotFound":
    case "PayeeNotPayable":
      return Effect.fail(new Conflict({ message: error.message }));
    case "PayrollPayeesHeld": {
      const details: PayeeChangeHold = {
        reason: "payee_details_changed",
        payees: error.payees.map((payee) => ({
          ...payee,
          detailsChangedAt: payee.detailsChangedAt.toISOString(),
        })),
      };
      return Effect.fail(new Conflict({ message: error.message, details }));
    }
  }
}

/** Every payout of these bills, any status. */
function payoutsOfBills(
  organizationId: string,
  billIds: readonly string[],
): Effect.Effect<Payout[], DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(payouts)
        .where(
          and(
            eq(payouts.organizationId, organizationId),
            eq(payouts.subjectType, "bill"),
            inArray(payouts.subjectId, [...billIds]),
          ),
        ),
    ),
  );
}

const pays = (payout: Payout, request: KesPayoutRequest): boolean =>
  payout.payrollRunId === request.payrollRunId &&
  payout.requestedKesCents === request.amountKesCents &&
  canonicalJson(payout.recipient) === canonicalJson(request.recipient);

/**
 * Each part's payout awaiting approval: the same one again while it still
 * pays exactly what's needed, otherwise a new one under the next key. A
 * stale payout, or one for a part or person no longer in the payment, is
 * discarded first (nothing was sent).
 */
function awaitingPayouts(
  organizationId: string,
  actor: AuditActor,
  run: PayrollRun,
  payments: readonly PayablePayrollPayment[],
  paidParts: ReadonlyMap<string, ReadonlySet<number>>,
): Effect.Effect<Payout[], PayrollPaymentError, PayoutEngineDeps> {
  return Effect.gen(function* () {
    const paidOf = (billId: string) => paidParts.get(billId) ?? new Set();
    const needed = new Map(
      payrollPayoutRequests(run.id, payments, { paidParts: paidOf }).map(
        (request) => [
          partKey(request.subjectId, request.subjectPart ?? 1),
          request,
        ],
      ),
    );
    const existing = yield* payoutsOfBills(
      organizationId,
      payments.map((payment) => payment.billId),
    );
    const names = new Map(
      payments.map((payment) => [payment.billId, payment.payeeName]),
    );
    const stale: Payout[] = [];
    for (const payout of existing) {
      if (payout.status === "failed" || payout.status === "paid") continue;
      const request = needed.get(partKey(payout.subjectId, payout.subjectPart));
      if (payout.status !== "awaiting_approval") {
        return yield* Effect.fail(
          new Conflict({
            message: `${names.get(payout.subjectId) ?? "Someone"} is already being paid.`,
          }),
        );
      }
      if (!request || !pays(payout, request)) stale.push(payout);
    }
    const leftOut = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(payouts)
          .where(
            and(
              eq(payouts.organizationId, organizationId),
              eq(payouts.payrollRunId, run.id),
              eq(payouts.status, "awaiting_approval"),
              payments.length === 0
                ? sql`true`
                : notInArray(
                    payouts.subjectId,
                    payments.map((payment) => payment.billId),
                  ),
            ),
          ),
      ),
    );
    for (const payout of [...stale, ...leftOut]) {
      yield* withScope({ organizationId }, (tx) =>
        discardUnapprovedPayout(tx, {
          organizationId,
          payoutId: payout.id,
          reason: REPLACED,
          actor,
        }),
      );
    }

    const failed = new Map<string, number>();
    for (const payout of existing) {
      if (payout.status !== "failed" && !stale.includes(payout)) continue;
      const key = partKey(payout.subjectId, payout.subjectPart);
      failed.set(key, (failed.get(key) ?? 0) + 1);
    }
    const requests = payrollPayoutRequests(run.id, payments, {
      paidParts: paidOf,
      attemptOf: (billId, part) => (failed.get(partKey(billId, part)) ?? 0) + 1,
    });
    return yield* preparePayouts({ organizationId, actor, requests });
  });
}

export interface PayrollPersonPreviewView extends PaymentCost {
  readonly billId: string;
  readonly payeeName: string;
  readonly paidTo: PaymentDestination;
  /** What this payment pays them: their pay, or what's left after paid parts. */
  readonly amountKes: bigint;
  /** What reaches them: each order rounded up to a whole shilling. */
  readonly receivesKes: bigint;
  /** More than one when the salary is above Paycrest's largest order. */
  readonly orders: number;
  readonly payoutIds: readonly string[];
}

export interface PayrollPaymentView {
  readonly challengeId: string;
  readonly options: ApprovalChallenge["options"];
  readonly runId: string;
  readonly people: readonly PayrollPersonPreviewView[];
  readonly totals: {
    readonly receivesKes: bigint;
    readonly usdc: bigint;
    readonly feeAllowanceUsdc: bigint;
    readonly maxDebitUsdc: bigint;
  };
  readonly cap: {
    readonly capKes: bigint;
    /** Already paid or being paid in this run. */
    readonly committedKes: bigint;
    /** Whether this payment fits: approving checks again, under lock. */
    readonly withinCap: boolean;
  };
  readonly wallet: WalletCover;
}

/** The run's payouts that count towards its cap, as the engine counts them. */
function committedKes(
  organizationId: string,
  runId: string,
): Effect.Effect<bigint, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          total: sql<string>`coalesce(sum(${payouts.amountKes}), 0)::text`,
        })
        .from(payouts)
        .where(
          and(
            eq(payouts.payrollRunId, runId),
            notInArray(payouts.status, ["awaiting_approval", "failed"]),
          ),
        ),
    ),
  ).pipe(Effect.map(([row]) => BigInt(row?.total ?? "0")));
}

function previewPeople(
  payments: readonly PayablePayrollPayment[],
  batch: readonly Payout[],
): PayrollPersonPreviewView[] {
  return payments.flatMap((payment) => {
    const parts = batch.filter((payout) => payout.subjectId === payment.billId);
    const [first] = parts;
    if (!first) return [];
    const sum = (pick: (payout: Payout) => bigint) =>
      parts.reduce((total, payout) => total + pick(payout), 0n);
    return [
      {
        billId: payment.billId,
        payeeName: payment.payeeName,
        paidTo: destinationOf(first.recipient),
        amountKes: sum((payout) => payout.requestedKesCents),
        receivesKes: sum((payout) => payout.amountKes),
        orders: parts.length,
        payoutIds: parts.map((payout) => payout.id),
        rate: first.quotedRate,
        usdc: sum((payout) => payout.quotedUsdc),
        feeAllowanceUsdc: sum((payout) => costOf(payout).feeAllowanceUsdc),
        maxDebitUsdc: sum((payout) => payout.maxDebitUsdc),
      },
    ];
  });
}

function approvalFor(
  tenant: Tenant,
  run: PayrollRun,
  payments: readonly PayablePayrollPayment[],
  paidParts: ReadonlyMap<string, ReadonlySet<number>>,
): Effect.Effect<PayrollPaymentView, PayrollPaymentError, PayoutEngineDeps> {
  const actor = { type: "user", id: tenant.userId } as const;
  return Effect.gen(function* () {
    const batch = yield* awaitingPayouts(
      tenant.organizationId,
      actor,
      run,
      payments,
      paidParts,
    );
    const challenge = yield* requestPayoutApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      payoutIds: batch.map((payout) => payout.id),
    });
    const people = previewPeople(payments, batch);
    const sum = (pick: (person: PayrollPersonPreviewView) => bigint) =>
      people.reduce((total, person) => total + pick(person), 0n);
    const committed = yield* committedKes(tenant.organizationId, run.id);
    const receivesKes = sum((person) => person.receivesKes);
    return {
      challengeId: challenge.challengeId,
      options: challenge.options,
      runId: run.id,
      people,
      totals: {
        receivesKes,
        usdc: sum((person) => person.usdc),
        feeAllowanceUsdc: sum((person) => person.feeAllowanceUsdc),
        maxDebitUsdc: sum((person) => person.maxDebitUsdc),
      },
      cap: {
        capKes: run.capKes,
        committedKes: committed,
        withinCap: committed + receivesKes <= run.capKes,
      },
      wallet: yield* walletCover(tenant.organizationId, batch),
    };
  });
}

/**
 * Approve & pay all, step one: the draft run and everyone in it, payable
 * now, with one passkey challenge for all their payouts. Someone whose
 * details changed in the last 24 hours needs `secondConfirmation`.
 */
export function requestPayrollRunPayment(
  tenant: Tenant,
  runId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<PayrollPaymentView, PayrollPaymentError, PayoutEngineDeps> {
  return Effect.gen(function* () {
    const { run, payments } = yield* withScope(tenant, (tx) =>
      payablePayrollRun(tx, tenant.organizationId, runId, confirmation),
    ).pipe(Effect.catchAll(payrollNotPayableAsClientError));
    return yield* approvalFor(tenant, run, payments, new Map());
  });
}

/**
 * One person's failed payment, again (spec §6.21): new payouts with new
 * keys for the parts not yet paid, waiting for a fresh passkey. Nobody
 * else is paid again.
 */
export function requestPayrollPaymentRetry(
  tenant: Tenant,
  runId: string,
  billId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<PayrollPaymentView, PayrollPaymentError, PayoutEngineDeps> {
  return Effect.gen(function* () {
    const { run, payment } = yield* withScope(tenant, (tx) =>
      payablePayrollRetry(
        tx,
        tenant.organizationId,
        runId,
        billId,
        confirmation,
      ),
    ).pipe(Effect.catchAll(payrollNotPayableAsClientError));
    const paid = (yield* payoutsOfBills(tenant.organizationId, [billId]))
      .filter((payout) => payout.status === "paid")
      .map((payout) => payout.subjectPart);
    return yield* approvalFor(
      tenant,
      run,
      [payment],
      new Map([[billId, new Set(paid)]]),
    );
  });
}

/**
 * Step two: the admin's passkey approves the run's payouts, and each is
 * funded once and on its own. Returns the run as it now stands.
 */
export function confirmPayrollRunPayment(
  tenant: Tenant,
  runId: string,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Effect.Effect<
  PayrollRunDetailView,
  PayoutRejected | Conflict | NotFound | Forbidden | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const batch = yield* challengePayouts(
      tenant,
      challengeId,
      approvalNotFound,
    );
    if (
      batch.some(
        (payout) =>
          payout.subjectType !== "bill" || payout.payrollRunId !== runId,
      )
    ) {
      return yield* Effect.fail(approvalNotFound);
    }
    yield* approveAndPay({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      challengeId,
      response,
    }).pipe(
      Effect.catchTag("PayoutRejected", (error) => topUpConflict(error, batch)),
    );
    return yield* getPayrollRun(tenant, runId);
  });
}
