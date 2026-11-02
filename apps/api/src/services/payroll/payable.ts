import { and, asc, eq, ne } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { BillRow, PayeeRow, PayrollRun } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { BillNotPayable } from "../bills/payable.js";
import type { KesRecipient, PayoutRecipient } from "../paycrest/recipient.js";
import type {
  PayeeChangeConfirmation,
  PayeeNotFound,
  PayeeNotPayable,
} from "../payees/payment-guard.js";
import type { KesPayoutRequest } from "../payout/prepare.js";
import { bills, payees, payrollRuns } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { assertBillPayable } from "../bills/payable.js";
import {
  PayeeChangeUnconfirmed,
  resolvePayeeRecipient,
} from "../payees/payment-guard.js";
import { salaryParts } from "./split.js";

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
 * The payout engine's subject hooks then move each bill to `paying` with
 * its payout, and the run with them (`bills/bill-payout-hooks.ts`,
 * `run-status.ts`). A salary above Paycrest's largest order becomes
 * several payouts, its parts (`split.ts`).
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

/**
 * People whose payment details changed in the last 24 hours (spec §6.19):
 * the admin is warned about all of them at once, and confirms a second
 * time.
 */
export class PayrollPayeesHeld extends Data.TaggedError("PayrollPayeesHeld")<{
  readonly payees: readonly {
    readonly payeeId: string;
    readonly name: string;
    readonly detailsChangedAt: Date;
  }[];
  readonly message: string;
}> {}

export type PayrollNotPayable =
  | NotFound
  | Conflict
  | BillNotPayable
  | PayeeNotFound
  | PayeeNotPayable
  | PayrollPayeesHeld
  | DatabaseError;

/**
 * One person's payment, payable now, or the change hold that stops it.
 * Salaries are paid in KES, so a payee whose details became a USDC address
 * is refused.
 */
function payablePayment(
  tx: Transaction,
  bill: BillRow,
  payee: PayeeRow,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<
  PayablePayrollPayment | PayeeChangeUnconfirmed,
  Conflict | BillNotPayable | PayeeNotFound | PayeeNotPayable | DatabaseError
> {
  return Effect.gen(function* () {
    const paidInUsdc = new Conflict({
      message: `${payee.name} is set up to be paid in USDC, and salaries are paid in KES. Give them an M-Pesa number or a bank account.`,
    });
    if (payee.method === "usdc") return yield* Effect.fail(paidInUsdc);
    const amount = yield* assertBillPayable({ bill, payee });
    if (amount.currency !== "kes") {
      return yield* Effect.dieMessage(`payroll bill ${bill.id} isn't in KES`);
    }
    const recipient = yield* resolvePayeeRecipient(
      tx,
      payee.id,
      confirmation,
    ).pipe(
      Effect.map(
        (resolved): PayoutRecipient | PayeeChangeUnconfirmed => resolved,
      ),
      Effect.catchTag("PayeeChangeUnconfirmed", (held) => Effect.succeed(held)),
    );
    if (recipient instanceof PayeeChangeUnconfirmed) return recipient;
    if (recipient.method === "usdc") return yield* Effect.fail(paidInUsdc);
    return {
      billId: bill.id,
      payeeId: payee.id,
      payeeName: payee.name,
      amountKesCents: amount.amountKes,
      recipient,
    };
  });
}

/** Every payment, or all the people inside their 24-hour hold. */
function payableOrHeld(
  tx: Transaction,
  rows: readonly { readonly bill: BillRow; readonly payee: PayeeRow }[],
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<PayablePayrollPayment[], PayrollNotPayable> {
  return Effect.gen(function* () {
    const payments: PayablePayrollPayment[] = [];
    const held: PayrollPayeesHeld["payees"][number][] = [];
    let message = "";
    for (const { bill, payee } of rows) {
      const payment = yield* payablePayment(tx, bill, payee, confirmation);
      if (payment instanceof PayeeChangeUnconfirmed) {
        held.push({
          payeeId: payment.payeeId,
          name: payee.name,
          detailsChangedAt: payment.detailsChangedAt,
        });
        message = payment.message;
      } else {
        payments.push(payment);
      }
    }
    if (held.length > 0) {
      return yield* Effect.fail(
        new PayrollPayeesHeld({
          payees: held,
          message:
            held.length === 1
              ? message
              : "Some people's payment details changed in the last 24 hours. Check them, then confirm again to pay.",
        }),
      );
    }
    return payments;
  });
}

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
    const payments = yield* payableOrHeld(tx, rows, confirmation);
    return { run, payments };
  });
}

/**
 * One person whose payment failed, to retry alone (spec §6.21): the run
 * is being paid or partly failed, and the bill is `payout_failed`. Locks
 * the run, then the bill, and resolves the recipient now.
 */
export function payablePayrollRetry(
  tx: Transaction,
  organizationId: string,
  runId: string,
  billId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<
  { readonly run: PayrollRun; readonly payment: PayablePayrollPayment },
  PayrollNotPayable
> {
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
    const [row] = yield* query(() =>
      tx
        .select({ bill: bills, payee: payees })
        .from(bills)
        .innerJoin(payees, eq(payees.id, bills.payeeId))
        .where(
          and(
            eq(bills.organizationId, organizationId),
            eq(bills.payrollRunId, runId),
            eq(bills.id, billId),
          ),
        )
        .for("update", { of: bills }),
    );
    if (!row) {
      return yield* Effect.fail(
        new NotFound({ message: "That payment isn't in this payroll run." }),
      );
    }
    if (row.bill.status !== "payout_failed") {
      return yield* Effect.fail(
        new Conflict({
          message: "Only a payment that failed can be retried.",
        }),
      );
    }
    const [payment] = yield* payableOrHeld(tx, [row], confirmation);
    if (!payment) return yield* Effect.dieMessage("retry found no payment");
    return { run, payment };
  });
}

export interface PayrollRequestOptions {
  /** The attempt number in the part's key, from 1: one more than its failed payouts. */
  readonly attemptOf?: (billId: string, part: number) => number;
  /** Parts already paid, which a retry leaves alone. */
  readonly paidParts?: (billId: string) => ReadonlySet<number>;
}

/**
 * The payout engine's requests for a run's payments: one per person, each
 * tagged with the run (the engine checks the run's cap) and keyed to the
 * bill, `payroll:<billId>:<n>`, so preparing twice returns the same
 * payouts. A salary above Paycrest's largest order is several requests,
 * parts 1, 2, …, keyed `payroll:<billId>:<n>:part<k>`.
 */
export function payrollPayoutRequests(
  runId: string,
  payments: readonly PayablePayrollPayment[],
  {
    attemptOf = () => 1,
    paidParts = () => new Set(),
  }: PayrollRequestOptions = {},
): KesPayoutRequest[] {
  return payments.flatMap((payment) => {
    const parts = salaryParts(payment.amountKesCents);
    const paid = paidParts(payment.billId);
    return parts.flatMap((amountKesCents, index) => {
      const part = index + 1;
      if (paid.has(part)) return [];
      const attempt = attemptOf(payment.billId, part);
      const base = {
        subjectType: "bill",
        subjectId: payment.billId,
        payrollRunId: runId,
        recipient: payment.recipient,
        amountKesCents,
      } as const;
      return parts.length === 1
        ? [{ ...base, idempotencyKey: `payroll:${payment.billId}:${attempt}` }]
        : [
            {
              ...base,
              subjectPart: part,
              idempotencyKey: `payroll:${payment.billId}:${attempt}:part${part}`,
            },
          ];
    });
  });
}
