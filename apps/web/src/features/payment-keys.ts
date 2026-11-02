import type { PayeeKind, PayeeMethod } from "@expendi-business/shared";

/**
 * Query keys for payees, bills, recurring payments and payroll (T48).
 * They change each other: settling a bill creates a recurring payment's
 * next one, and a payroll run's payments are bills.
 */

export interface PayeeListFilters {
  readonly kind: PayeeKind | null;
  readonly method: PayeeMethod | null;
  /** True lists only archived payees; the API leaves them out otherwise. */
  readonly archived: boolean;
}

export type BillListView = "open" | "history";

export const payeeKeys = {
  /** Every payee query of a company, to refresh after a change. */
  all: (organizationId: string) => ["payees", organizationId] as const,
  list: (organizationId: string, filters: PayeeListFilters) =>
    ["payees", organizationId, "list", filters] as const,
  detail: (organizationId: string, payeeId: string) =>
    ["payees", organizationId, "detail", payeeId] as const,
  banks: (organizationId: string) => ["payee-banks", organizationId] as const,
  allowlist: (organizationId: string) =>
    ["payees", organizationId, "allowlist"] as const,
};

export const billKeys = {
  /** Every bill query of a company, to refresh after a bill changes. */
  all: (organizationId: string) => ["bills", organizationId] as const,
  list: (organizationId: string, view: BillListView) =>
    ["bills", organizationId, "list", view] as const,
  detail: (organizationId: string, billId: string) =>
    ["bills", organizationId, "detail", billId] as const,
  paidFromAccounts: (organizationId: string) =>
    ["paid-from-accounts", organizationId] as const,
  kesRate: (organizationId: string) =>
    ["bills", organizationId, "kes-rate"] as const,
};

export const recurringKeys = {
  all: (organizationId: string) => ["recurring-items", organizationId] as const,
  list: (organizationId: string) =>
    ["recurring-items", organizationId, "list"] as const,
  detail: (organizationId: string, itemId: string) =>
    ["recurring-items", organizationId, "detail", itemId] as const,
};

export const payrollKeys = {
  /** Salaries, runs and the margin: a salary change can redraft a run. */
  all: (organizationId: string) => ["payroll", organizationId] as const,
  salaries: (organizationId: string) =>
    ["payroll", organizationId, "salaries"] as const,
  salary: (organizationId: string, salaryId: string) =>
    ["payroll", organizationId, "salaries", salaryId] as const,
  runs: (organizationId: string) =>
    ["payroll", organizationId, "runs"] as const,
  run: (organizationId: string, runId: string) =>
    ["payroll", organizationId, "runs", runId] as const,
  margin: (organizationId: string) =>
    ["payroll", organizationId, "margin"] as const,
};

/** The wallet page's queries (T49), to refresh after money moves. */
export const walletPrefix = (organizationId: string) =>
  ["wallet", organizationId] as const;
