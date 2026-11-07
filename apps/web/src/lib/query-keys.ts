import type {
  ExpenseStatus,
  ExpenseSummaryQuery,
} from "@expendi-business/shared";

import type { ExpenseListParams } from "./customer-api";

export const queryKeys = {
  me: (privyUserId: string) => ["me", privyUserId] as const,
  approvalPasskey: ["approval-passkey"] as const,
  categories: (organizationId: string) =>
    ["categories", organizationId] as const,
  members: (organizationId: string) => ["members", organizationId] as const,
  /** Every expense query of a company, to refresh after a claim changes. */
  expenses: (organizationId: string) => ["expenses", organizationId] as const,
  expenseList: (organizationId: string, query: ExpenseListParams) =>
    ["expenses", organizationId, "list", query] as const,
  expense: (organizationId: string, expenseId: string) =>
    ["expenses", organizationId, "detail", expenseId] as const,
  expenseSummary: (organizationId: string, query: ExpenseSummaryQuery) =>
    ["expenses", organizationId, "summary", query] as const,
  /** Every claim query of a company. */
  claims: (organizationId: string) => ["claims", organizationId] as const,
  claimQueue: (organizationId: string, status: ExpenseStatus) =>
    ["claims", organizationId, "queue", status] as const,
  claim: (organizationId: string, claimId: string) =>
    ["claims", organizationId, "detail", claimId] as const,
};
