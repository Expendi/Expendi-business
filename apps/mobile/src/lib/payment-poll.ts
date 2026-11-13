import type { InvalidateQueryFilters } from "@tanstack/react-query";

import type {
  BillStatus,
  ExpenseStatus,
  FloatMovementPhase,
  PaymentStatuses,
  PayoutStatus,
  PayrollRunStatus,
} from "@expendi-business/shared";
import { EXPENSE_STATUSES, isPaymentInFlight } from "@expendi-business/shared";

import { queryKeys } from "./query-keys";

/**
 * What each screen's data shows of payments, for `paymentPollInterval`:
 * each query asks again every few seconds while one is on its way, and
 * stops by itself once none is. Undefined data shows none.
 */

interface WithStatus<T> {
  readonly status: T;
}

export function billListStatuses(
  bills: readonly WithStatus<BillStatus>[] | undefined,
): PaymentStatuses {
  return { bills: bills?.map((bill) => bill.status) };
}

export function billStatuses(
  bill: WithStatus<BillStatus> | undefined,
): PaymentStatuses {
  return { bills: bill && [bill.status] };
}

export function claimPagesStatuses(
  data:
    | {
        readonly pages: readonly {
          readonly claims: readonly WithStatus<ExpenseStatus>[];
        }[];
      }
    | undefined,
): PaymentStatuses {
  return {
    claims: data?.pages.flatMap((page) =>
      page.claims.map((claim) => claim.status),
    ),
  };
}

export function claimStatuses(
  claim:
    | (WithStatus<ExpenseStatus> & {
        readonly payout: WithStatus<PayoutStatus> | null;
      })
    | undefined,
): PaymentStatuses {
  return {
    claims: claim && [claim.status],
    payouts: claim?.payout ? [claim.payout.status] : undefined,
  };
}

export function payrollRunListStatuses(
  runs: readonly WithStatus<PayrollRunStatus>[] | undefined,
): PaymentStatuses {
  return { payrollRuns: runs?.map((run) => run.status) };
}

/** A run and each of its payments, which are bills. */
export function payrollRunStatuses(
  run:
    | (WithStatus<PayrollRunStatus> & {
        readonly payments: readonly WithStatus<BillStatus>[];
      })
    | undefined,
): PaymentStatuses {
  return {
    payrollRuns: run && [run.status],
    bills: run?.payments.map((payment) => payment.status),
  };
}

export function mySalaryPaymentStatuses(
  payments: readonly WithStatus<BillStatus>[] | undefined,
): PaymentStatuses {
  return { bills: payments?.map((payment) => payment.status) };
}

/** A float's summary has no movements: what's on its way shows as an amount. */
export function floatListStatuses(
  response:
    | { readonly floats: readonly { readonly onTheWayKes: string }[] }
    | undefined,
): PaymentStatuses {
  return {
    floatMovements: response?.floats
      .filter((float) => BigInt(float.onTheWayKes) > 0n)
      .map(() => "on_its_way"),
  };
}

/** Its issues and top-ups, and the claims for spending over it. */
export function floatStatuses(
  float:
    | {
        readonly movements: readonly { readonly phase: FloatMovementPhase }[];
        readonly overspendClaims: readonly WithStatus<ExpenseStatus>[];
      }
    | undefined,
): PaymentStatuses {
  return {
    floatMovements: float?.movements.map((movement) => movement.phase),
    claims: float?.overspendClaims.map((claim) => claim.status),
  };
}

export function walletHistoryStatuses(
  data:
    | {
        readonly pages: readonly {
          readonly items: readonly {
            readonly payout: WithStatus<PayoutStatus> | null;
          }[];
        }[];
      }
    | undefined,
): PaymentStatuses {
  return {
    payouts: data?.pages.flatMap((page) =>
      page.items.flatMap((item) => (item.payout ? [item.payout.status] : [])),
    ),
  };
}

const isExpenseStatus = (status: string): status is ExpenseStatus =>
  (EXPENSE_STATUSES as readonly string[]).includes(status);

/** The overview's sheet on one person; its claim statuses come as text. */
export function overviewPersonStatuses(
  person: { readonly claims: readonly WithStatus<string>[] } | undefined,
): PaymentStatuses {
  return {
    claims: person?.claims.map((claim) => claim.status).filter(isExpenseStatus),
  };
}

/** How many of `statuses` are payments on their way. */
export function inFlightCount(statuses: PaymentStatuses): number {
  const count = <T>(
    list: readonly T[] | undefined,
    one: (status: T) => PaymentStatuses,
  ): number =>
    list?.filter((status) => isPaymentInFlight(one(status))).length ?? 0;
  return (
    count(statuses.bills, (status) => ({ bills: [status] })) +
    count(statuses.claims, (status) => ({ claims: [status] })) +
    count(statuses.payrollRuns, (status) => ({ payrollRuns: [status] })) +
    count(statuses.floatMovements, (status) => ({ floatMovements: [status] })) +
    count(statuses.payouts, (status) => ({ payouts: [status] }))
  );
}

/** The kinds of screen that follow payments until they settle. */
export type PaymentSurface =
  "bills" | "claims" | "payroll" | "floats" | "wallet_history";

/**
 * What else to fetch again once a payment a surface shows settles: its
 * own lists and counts, and the wallet's balance and history it moved.
 */
export function refreshedWhenSettled(
  surface: PaymentSurface,
  organizationId: string,
): InvalidateQueryFilters[] {
  const balance = { queryKey: queryKeys.wallet(organizationId), exact: true };
  const wallet = [
    balance,
    { queryKey: queryKeys.walletHistory(organizationId) },
  ];
  switch (surface) {
    case "bills":
      return [
        { queryKey: queryKeys.bills(organizationId) },
        { queryKey: queryKeys.recurringItems(organizationId) },
        ...wallet,
      ];
    case "claims":
      return [{ queryKey: queryKeys.claims(organizationId) }, ...wallet];
    case "payroll":
      return [
        { queryKey: queryKeys.payroll(organizationId) },
        { queryKey: queryKeys.mySalaryPayments(organizationId) },
        { queryKey: queryKeys.bills(organizationId) },
        ...wallet,
      ];
    case "floats":
      return [{ queryKey: queryKeys.floats(organizationId) }, ...wallet];
    case "wallet_history":
      return [balance];
  }
}
