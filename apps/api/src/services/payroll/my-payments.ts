import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import type { MySalaryPayment } from "@expendi-business/shared";
import { MY_SALARY_PAYMENT_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import { bills, payees } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";

/** `MySalaryPayment` before serialisation turns bigints into strings. */
export type MySalaryPaymentView = Omit<MySalaryPayment, "amountKes"> & {
  readonly amountKes: bigint;
};

const isMyPaymentStatus = (
  status: string,
): status is MySalaryPayment["status"] =>
  (MY_SALARY_PAYMENT_STATUSES as readonly string[]).includes(status);

/**
 * The caller's own salary payments (spec §4, §6.24), whatever their role:
 * payroll bills to a payee linked to their membership, once the run is
 * approved. Row-level security (`bills_own_salary_payments`) limits an
 * employee to exactly these rows; the membership filter does the same for
 * an admin, who can see everyone's.
 */
export function listMySalaryPayments(
  tenant: Tenant,
): Effect.Effect<MySalaryPaymentView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select({
          id: bills.id,
          salaryId: bills.recurringItemId,
          payDate: bills.dueOn,
          amountKes: bills.amountKes,
          status: bills.status,
          paidOn: bills.paidOn,
        })
        .from(bills)
        .innerJoin(payees, eq(payees.id, bills.payeeId))
        .where(
          and(
            eq(bills.organizationId, tenant.organizationId),
            isNotNull(bills.payrollRunId),
            eq(payees.membershipId, tenant.membershipId),
            inArray(bills.status, [...MY_SALARY_PAYMENT_STATUSES]),
          ),
        )
        .orderBy(desc(bills.dueOn), desc(bills.createdAt)),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          row.amountKes === null || !isMyPaymentStatus(row.status)
            ? Effect.dieMessage(`salary payment ${row.id} isn't settled`)
            : Effect.succeed({
                id: row.id,
                kind:
                  row.salaryId === null
                    ? ("one_off" as const)
                    : ("salary" as const),
                payDate: row.payDate,
                amountKes: row.amountKes,
                status: row.status,
                paidOn: row.paidOn,
              }),
        ),
      ),
    ),
  );
}
