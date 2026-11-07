"use client";

import { useQuery } from "@tanstack/react-query";

import type {
  BillsSummary,
  ClaimsSummary,
  ExpensesSummary,
  ExpenseSummaryQuery,
  PayrollRun,
} from "@expendi-business/shared";
import {
  billsSummarySchema,
  claimsSummarySchema,
  expensesSummarySchema,
} from "@expendi-business/shared";

import type { NavCountKey } from "~/config/navigation";
import { billKeys } from "~/features/payment-keys";
import { usePayrollRuns } from "~/features/payroll/payroll-api";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/lib/use-api";

export type NavCounts = Partial<Record<NavCountKey, number>>;

/** Petty cash spending, as Overview's "Missing documents" reads it. */
const PETTY_CASH_RECORDED = {
  kind: "petty_cash",
  status: "recorded",
} as const satisfies ExpenseSummaryQuery;
const PETTY_CASH_WITH_RECEIPT = {
  ...PETTY_CASH_RECORDED,
  noReceipt: "false",
} as const satisfies ExpenseSummaryQuery;

/**
 * The unfiltered summaries the badges read. They sit under the bills and
 * claims prefixes, so whatever refreshes those lists refreshes the badges;
 * a page reading the same summary can share these keys.
 */
export const navCountKeys = {
  billsSummary: (organizationId: string) =>
    [...billKeys.all(organizationId), "summary", {}] as const,
  claimsSummary: (organizationId: string) =>
    [...queryKeys.claims(organizationId), "summary"] as const,
  pettyCashSummary: (organizationId: string) =>
    queryKeys.expenseSummary(organizationId, PETTY_CASH_RECORDED),
  pettyCashWithReceiptSummary: (organizationId: string) =>
    queryKeys.expenseSummary(organizationId, PETTY_CASH_WITH_RECEIPT),
};

/** Overdue, due today and failed bills; the summary never counts salaries. */
export function billsNeedingAction(summary: BillsSummary): number {
  return (
    summary.overdue.count + summary.dueToday.count + summary.payoutFailed.count
  );
}

/** Reimbursements waiting for approval. */
export function claimsWaiting(summary: ClaimsSummary): number {
  return summary.waiting.count;
}

/**
 * Petty cash spending still missing a document, as Overview's "Missing
 * documents" counts it: no receipt, or a receipt but no eTIMS invoice.
 * The second count is asked of spending with a receipt, so one missing
 * both counts once.
 */
export function expensesMissingDocuments(
  recorded: ExpensesSummary,
  withReceipt: ExpensesSummary,
): number {
  return recorded.withoutReceipt.count + withReceipt.withoutEtims.count;
}

/** Draft runs to approve and partly failed runs to retry. */
export function payrollRunsWaiting(runs: readonly PayrollRun[]): number {
  return runs.filter(
    (run) => run.status === "draft" || run.status === "partly_failed",
  ).length;
}

/** The sidebar's badges. */
export function useNavCounts(organizationId: string): NavCounts {
  const api = useApi();
  const bills = useQuery({
    queryKey: navCountKeys.billsSummary(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/bills/summary`,
        billsSummarySchema,
      ),
  });
  const claims = useQuery({
    queryKey: navCountKeys.claimsSummary(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/claims/summary`,
        claimsSummarySchema,
      ),
  });
  const pettyCash = useQuery({
    queryKey: navCountKeys.pettyCashSummary(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/expenses/summary?${new URLSearchParams(PETTY_CASH_RECORDED).toString()}`,
        expensesSummarySchema,
      ),
  });
  const pettyCashWithReceipt = useQuery({
    queryKey: navCountKeys.pettyCashWithReceiptSummary(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/expenses/summary?${new URLSearchParams(PETTY_CASH_WITH_RECEIPT).toString()}`,
        expensesSummarySchema,
      ),
  });
  const runs = usePayrollRuns(organizationId);
  return {
    approvals: claims.data ? claimsWaiting(claims.data) : undefined,
    expenses:
      pettyCash.data && pettyCashWithReceipt.data
        ? expensesMissingDocuments(pettyCash.data, pettyCashWithReceipt.data)
        : undefined,
    bills: bills.data ? billsNeedingAction(bills.data) : undefined,
    payroll: runs.data ? payrollRunsWaiting(runs.data) : undefined,
  };
}
