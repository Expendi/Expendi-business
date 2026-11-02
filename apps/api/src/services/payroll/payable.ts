import { and, asc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import type { PayrollRun } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { BillNotPayable } from "../bills/payable.js";
import type { KesRecipient } from "../paycrest/recipient.js";
import type {
  PayeeChangeConfirmation,
  PayeeChangeUnconfirmed,
  PayeeNotFound,
  PayeeNotPayable,
} from "../payees/payment-guard.js";
import type { KesPayoutRequest } from "../payout/prepare.js";
import { bills, payees, payrollRuns } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { assertBillPayable } from "../bills/payable.js";
import { resolvePayeeRecipient } from "../payees/payment-guard.js";

/**
 * The seam for paying a payroll run (T39). Approve & pay all is:
 *
 * 1. In one transaction in the admin's scope: `payablePayrollRun` locks
 *    the draft run and every payment in it, checks each bill can be paid
 *    and resolves its recipient now (`resolvePayeeRecipient`: the 24-hour
 *    hold, the employee's confirmed M-Pesa number).
 * 2. `payrollPayoutRequests` turns them into the engine's requests, each
 *    tagged with the run so `approvePayouts` checks the run's cap.
 * 3. `preparePayouts` with those, then `requestPayoutApproval` /
 *    `approveAndPay` as for any batch: one passkey for the run, one payout
 *    per person, each failing on its own.
 *
 * T39 then moves the run to `paying` and each bill to `paying` with its
 * payout, and on to `paid` / `partly_failed` as payouts settle.
 */

export interface PayablePayrollPayment {
  readonly billId: string;
  readonly payeeId: string;
  readonly payeeName: string;
  readonly amountKesCents: bigint;
  readonly recipient: KesRecipient;
}

export interface PayablePayrollRun {
  readonly run: PayrollRun;
  readonly payments: readonly PayablePayrollPayment[];
}

export type PayrollNotPayable =
  | NotFound
  | Conflict
  | BillNotPayable
  | PayeeNotFound
  | PayeeNotPayable
  | PayeeChangeUnconfirmed
  | DatabaseError;

/**
 * The draft run and everyone in it who isn't left out, ready to pay: each
 * bill locked and checked, each recipient resolved at this moment. Runs
 * inside the caller's transaction, in the admin's scope. Salaries are paid
 * in KES, so a payee whose details became a USDC address is refused.
 */
export function payablePayrollRun(
  tx: Transaction,
  organizationId: string,
  runId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<PayablePayrollRun, PayrollNotPayable> {
  return Effect.gen(function* () {
    const [run] = yield* query(() =>
      tx
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.organizationId, organizationId),
            eq(payrollRuns.id, runId),
          ),
        )
        .for("update"),
    );
    if (!run) {
      return yield* Effect.fail(
        new NotFound({ message: "That payroll run wasn't found." }),
      );
    }
    if (run.status !== "draft") {
      return yield* Effect.fail(
        new Conflict({ message: "This payroll run is already approved." }),
      );
    }
    const rows = yield* query(() =>
      tx
        .select({ bill: bills, payee: payees })
        .from(bills)
        .innerJoin(payees, eq(payees.id, bills.payeeId))
        .where(
          and(
            eq(bills.organizationId, organizationId),
            eq(bills.payrollRunId, runId),
            ne(bills.status, "cancelled"),
          ),
        )
        .orderBy(asc(bills.id))
        .for("update", { of: bills }),
    );
    if (rows.length === 0) {
      return yield* Effect.fail(
        new Conflict({ message: "Everyone is left out of this run." }),
      );
    }
    const payments: PayablePayrollPayment[] = [];
    for (const { bill, payee } of rows) {
      const { amountKes } = yield* assertBillPayable({ bill, payee });
      const recipient = yield* resolvePayeeRecipient(
        tx,
        payee.id,
        confirmation,
      );
      if (recipient.method === "usdc") {
        return yield* Effect.fail(
          new Conflict({
            message: `${payee.name} is set up to be paid in USDC, and salaries are paid in KES. Give them an M-Pesa number or a bank account.`,
          }),
        );
      }
      payments.push({
        billId: bill.id,
        payeeId: payee.id,
        payeeName: payee.name,
        amountKesCents: amountKes,
        recipient,
      });
    }
    return { run, payments };
  });
}

/**
 * The payout engine's requests for a run's payments: one per bill, each
 * tagged with the run (the engine checks the run's cap) and keyed to the
 * bill, so preparing twice returns the same payouts. `attempt` starts at
 * 1; a retry of one person goes through `retryPayout` instead.
 */
export function payrollPayoutRequests(
  runId: string,
  payments: readonly PayablePayrollPayment[],
  attempt = 1,
): KesPayoutRequest[] {
  return payments.map((payment) => ({
    subjectType: "bill",
    subjectId: payment.billId,
    payrollRunId: runId,
    idempotencyKey: `payroll:${payment.billId}:${attempt}`,
    recipient: payment.recipient,
    amountKesCents: payment.amountKesCents,
  }));
}
