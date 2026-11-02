import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { BillStatus } from "@expendi-business/shared";

import type { BillRow, Payout, PayrollRun } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { SubjectHooks } from "../payout/subjects.js";
import type { BillAmount } from "./payable.js";
import {
  bills,
  payees,
  payouts,
  payrollRuns,
  recurringItems,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { canonicalJson } from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { notify } from "../notification/notify.js";
import { resolveApprovedPayeeRecipient } from "../payees/payment-guard.js";
import { PayoutRejected } from "../payout/payout-errors.js";
import { refreshPayrollRunStatus } from "../payroll/run-status.js";
import { salaryParts } from "../payroll/split.js";
import { onRecurringBillSettled } from "../recurring/next-bill.js";
import { enqueuePaidBill } from "../zoho/enqueue.js";
import { assertBillPayable, billAmountOf } from "./payable.js";
import { nairobiDate } from "./status.js";

/**
 * A bill follows its payout (spec §6.20), as a claim does (T19):
 *
 * - **Approved:** under the approval's locks, the bill is checked again
 *   (still unpaid and payable, the same amount, the payee's details as
 *   they were when the payment was prepared) and moves to `paying` with
 *   the payout. A refusal rolls the whole approval back.
 * - **Paid:** the bill is `paid`, and in the same transaction it's queued
 *   for Zoho Books (T44) and a recurring bill's next one is created (T36).
 * - **Failed:** the bill is `payout_failed`; the admin retries it.
 * - **Needs review:** the bill stays `paying` until a person resolves it.
 *
 * Only the bill's current payment moves it: an outcome for any other
 * payout, or one applied twice, changes nothing.
 *
 * **Payroll** (spec §6.21): a salary bill belongs to its run, which moves
 * with its payments (`run-status.ts`), locked before the bill. A salary
 * above Paycrest's largest order is paid as several orders (`split.ts`),
 * all approved together: the bill is `paid` once every part is, and
 * `payout_failed` once a part failed and none is still in flight. Its
 * retry pays only the parts not yet paid.
 *
 * A payout whose bill row doesn't exist (the engine driven directly, as
 * the Checkpoint B script does) has nothing to follow.
 */

const SYSTEM = { type: "system", id: "bill-payouts" } as const;

const refuse = (message: string) =>
  Effect.fail(new PayoutRejected({ reason: "subject_not_payable", message }));

/**
 * Bills, recurring items and payroll runs are admins-only in row-level
 * security. The engine's own transactions (funding, sync, reconciliation,
 * staff resolution) act for no person and carry no role (migration 0045),
 * so the bill's side runs as the company's admin role there, as the
 * recurring-bills job does. A person's other role is never raised.
 */
function asCompany<A, E, R>(
  tx: Transaction,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R> {
  return Effect.gen(function* () {
    const { rows } = yield* query(() =>
      tx.execute<{ role: string | null }>(
        sql`SELECT current_setting('app.role', true) AS role`,
      ),
    );
    const role = rows[0]?.role ?? "";
    if (role === "admin") return yield* work;
    if (role !== "") {
      return yield* Effect.dieMessage(
        `a bill's payout was applied in a ${role} scope`,
      );
    }
    yield* query(() =>
      tx.execute(sql`SELECT set_config('app.role', 'admin', true)`),
    );
    const result = yield* work;
    yield* query(() =>
      tx.execute(sql`SELECT set_config('app.role', '', true)`),
    );
    return result;
  });
}

function lockBillOf(tx: Transaction, payout: Payout) {
  return query(() =>
    tx
      .select({
        bill: bills,
        payee: { name: payees.name, kind: payees.kind, method: payees.method },
        recurringPayVia: recurringItems.payVia,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
      .where(
        and(
          eq(bills.id, payout.subjectId),
          eq(bills.organizationId, payout.organizationId),
        ),
      )
      .for("update", { of: bills }),
  ).pipe(Effect.map(([found]) => found ?? null));
}

/** The payout's run, locked before its bill, as drafting and paying lock them. */
function lockRunOf(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<PayrollRun | null, DatabaseError> {
  const { payrollRunId } = payout;
  if (payrollRunId === null) return Effect.succeed(null);
  return query(() =>
    tx
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.id, payrollRunId),
          eq(payrollRuns.organizationId, payout.organizationId),
        ),
      )
      .for("update"),
  ).pipe(Effect.map(([run]) => run ?? null));
}

type BillPayment = Pick<
  Payout,
  | "id"
  | "subjectPart"
  | "status"
  | "approvalId"
  | "provider"
  | "requestedKesCents"
  | "quotedUsdc"
  | "recipient"
>;

/** Every payout the bill has had, any status. */
function paymentsOf(
  tx: Transaction,
  bill: BillRow,
): Effect.Effect<BillPayment[], DatabaseError> {
  return query(() =>
    tx
      .select({
        id: payouts.id,
        subjectPart: payouts.subjectPart,
        status: payouts.status,
        approvalId: payouts.approvalId,
        provider: payouts.provider,
        requestedKesCents: payouts.requestedKesCents,
        quotedUsdc: payouts.quotedUsdc,
        recipient: payouts.recipient,
      })
      .from(payouts)
      .where(
        and(
          eq(payouts.organizationId, bill.organizationId),
          eq(payouts.subjectType, "bill"),
          eq(payouts.subjectId, bill.id),
        ),
      ),
  );
}

/** One order of a bill's payment: a salary over Paycrest's largest order has several. */
interface Order {
  readonly part: number;
  readonly amount: BillAmount;
}

function ordersOf(bill: BillRow, amount: BillAmount): Order[] {
  if (bill.payrollRunId === null || amount.currency === "usd") {
    return [{ part: 1, amount }];
  }
  return salaryParts(amount.amountKes).map((amountKes, index) => ({
    part: index + 1,
    amount: { currency: "kes", amountKes },
  }));
}

/** Whether `payment` pays exactly `amount`: KES through Paycrest, or the exact USDC on chain. */
function paysAmount(payment: BillPayment, amount: BillAmount): boolean {
  return amount.currency === "usd"
    ? payment.provider === "onchain" && payment.quotedUsdc === amount.amountUsdc
    : payment.provider === "paycrest" &&
        payment.requestedKesCents === amount.amountKes;
}

/**
 * Whether the parts approved now, with any paid before, pay each order
 * exactly once and nothing else.
 */
function coversOrders(
  orders: readonly Order[],
  approvedNow: readonly BillPayment[],
  paidBefore: readonly BillPayment[],
): boolean {
  const known = new Set(orders.map((order) => order.part));
  return (
    approvedNow.every((payment) => known.has(payment.subjectPart)) &&
    orders.every((order) => {
      const paying = [...approvedNow, ...paidBefore].filter(
        (payment) => payment.subjectPart === order.part,
      );
      const [only] = paying;
      return (
        paying.length === 1 &&
        only !== undefined &&
        paysAmount(only, order.amount)
      );
    })
  );
}

/** The approval of the bill's current payment: the one its `payout_id` names. */
const currentApprovalOf = (
  bill: BillRow,
  payments: readonly BillPayment[],
): string | null =>
  payments.find((payment) => payment.id === bill.payoutId)?.approvalId ?? null;

function approveBill(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, PayoutRejected | DatabaseError, AuditLog> {
  return asCompany(
    tx,
    Effect.gen(function* () {
      const run = yield* lockRunOf(tx, payout);
      const found = yield* lockBillOf(tx, payout);
      if (!found) return;
      const { bill, payee } = found;
      const { approvedBy, approvedAt, approvalId } = payout;
      if (!approvedBy || !approvedAt || !approvalId) {
        return yield* Effect.dieMessage(
          `payout ${payout.id} reached its subject unapproved`,
        );
      }
      if (bill.payrollRunId !== payout.payrollRunId) {
        return yield* refuse(
          "This payment doesn't belong to this bill's payroll run. Nothing was sent.",
        );
      }
      const payments = yield* paymentsOf(tx, bill);
      if (
        bill.status === "paying" &&
        currentApprovalOf(bill, payments) === approvalId
      ) {
        return;
      }
      const amount = yield* assertBillPayable({
        bill,
        payee,
        recurringItem:
          found.recurringPayVia === null
            ? null
            : { payVia: found.recurringPayVia },
      }).pipe(
        Effect.catchTag("BillNotPayable", (error) =>
          refuse(`${error.message} Nothing was sent.`),
        ),
      );
      const approvedNow = payments.filter(
        (payment) =>
          payment.approvalId === approvalId && payment.status === "approved",
      );
      const paidBefore = payments.filter(
        (payment) => payment.status === "paid",
      );
      if (!coversOrders(ordersOf(bill, amount), approvedNow, paidBefore)) {
        return yield* refuse(
          "This bill changed after the payment was prepared. Nothing was sent. Review it and pay again.",
        );
      }
      const recipient = yield* resolveApprovedPayeeRecipient(
        tx,
        bill.payeeId,
        payout.createdAt,
      ).pipe(
        Effect.catchTags({
          PayeeNotFound: (error) => refuse(error.message),
          PayeeNotPayable: (error) =>
            refuse(`${error.message} Nothing was sent.`),
          PayeeChangedSincePrepared: (error) => refuse(error.message),
        }),
      );
      if (
        approvedNow.some(
          (payment) =>
            canonicalJson(payment.recipient) !== canonicalJson(recipient),
        )
      ) {
        return yield* refuse(
          `${payee.name}'s payment details changed after the payment was prepared. Nothing was sent. Pay again to use the new details.`,
        );
      }

      yield* query(() =>
        tx
          .update(bills)
          .set({ status: "paying", payoutId: payout.id })
          .where(eq(bills.id, bill.id)),
      );
      const audit = yield* AuditLog;
      const actor = { type: "user", id: approvedBy } as const;
      yield* audit.record(tx, {
        actor,
        organizationId: payout.organizationId,
        action: "bill.payment_approved",
        entity: { type: "bill", id: bill.id },
        before: { status: bill.status },
        after: {
          status: "paying",
          payoutId: payout.id,
          approvalId,
          currency: bill.currency,
          amountKes: bill.amountKes,
          amountUsdc: bill.amountUsdc,
          kesEquivalent: payout.amountKes,
          payoutIds: approvedNow.map((payment) => payment.id),
          paidBefore: paidBefore.map((payment) => payment.id),
        },
      });
      if (run) {
        yield* refreshPayrollRunStatus(tx, run, actor, {
          approvedBy,
          approvedAt,
        });
      }
    }),
  );
}

/** Where a `paying` bill's payout outcome points it. */
const OUTCOMES: Partial<Record<Payout["status"], SettledStatus>> = {
  paid: "paid",
  failed: "payout_failed",
};

type SettledStatus = Extract<BillStatus, "paid" | "payout_failed">;

const ACTIONS: Readonly<Record<SettledStatus, string>> = {
  paid: "bill.paid",
  payout_failed: "bill.payout_failed",
};

/** Payouts whose outcome isn't known yet; money may be on its way. */
const IN_FLIGHT: readonly Payout["status"][] = [
  "approved",
  "order_created",
  "funding",
  "paying",
  "needs_review",
];

/**
 * Where the bill goes now: a bill paid in one order follows it; a split
 * salary is paid once every part is, and failed once a part failed and
 * none is still in flight. Null leaves it `paying`.
 */
function settledStatus(
  orders: readonly Order[],
  payments: readonly BillPayment[],
  outcome: SettledStatus,
): SettledStatus | null {
  if (orders.length === 1) return outcome;
  const live = payments.filter((payment) => payment.status !== "failed");
  const paidParts = new Set(
    live
      .filter((payment) => payment.status === "paid")
      .map((payment) => payment.subjectPart),
  );
  if (orders.every((order) => paidParts.has(order.part))) return "paid";
  if (live.some((payment) => IN_FLIGHT.includes(payment.status))) return null;
  return "payout_failed";
}

function followPayout(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, DatabaseError, AuditLog> {
  const outcome = OUTCOMES[payout.status];
  if (!outcome) return Effect.void;
  return asCompany(
    tx,
    Effect.gen(function* () {
      const run = yield* lockRunOf(tx, payout);
      const found = yield* lockBillOf(tx, payout);
      if (found?.bill.status !== "paying") return;
      const { bill } = found;
      const payments = yield* paymentsOf(tx, bill);
      const isCurrentPayment =
        payout.id === bill.payoutId ||
        (payout.approvalId !== null &&
          payout.approvalId === currentApprovalOf(bill, payments));
      if (!isCurrentPayment) return;
      const amount = billAmountOf(bill);
      if (amount === null) {
        return yield* Effect.dieMessage(`paying bill ${bill.id} has no amount`);
      }
      const next = settledStatus(ordersOf(bill, amount), payments, outcome);
      if (next === null) return;

      const paidAt = payout.paidAt ?? new Date();
      const [moved] = yield* query(() =>
        tx
          .update(bills)
          .set({
            status: next,
            ...(next === "paid" && { paidAt, paidOn: nairobiDate(paidAt) }),
          })
          .where(and(eq(bills.id, bill.id), eq(bills.status, "paying")))
          .returning(),
      );
      if (!moved) return;
      const audit = yield* AuditLog;
      yield* audit.record(tx, {
        actor: SYSTEM,
        organizationId: payout.organizationId,
        action: ACTIONS[next],
        entity: { type: "bill", id: bill.id },
        before: { status: "paying" },
        after: {
          status: next,
          payoutId: payout.id,
          ...(next === "paid"
            ? {
                paidAt: moved.paidAt,
                paidOn: moved.paidOn,
                kesEquivalent: payout.amountKes,
                providerReference: payout.providerReference,
              }
            : { reason: payout.failureReason }),
        },
      });
      if (next === "paid" && moved.payrollRunId === null) {
        yield* enqueuePaidBill(tx, moved.organizationId, moved.id);
        yield* onRecurringBillSettled(tx, moved, new Date());
      }
      if (next === "paid" && moved.payrollRunId !== null) {
        yield* notify(tx, {
          kind: "salary_paid",
          organizationId: moved.organizationId,
          billId: moved.id,
        });
      }
      if (run) yield* refreshPayrollRunStatus(tx, run, SYSTEM);
    }),
  );
}

export const billPayoutHooks: SubjectHooks = {
  approved: approveBill,
  changed: followPayout,
};
