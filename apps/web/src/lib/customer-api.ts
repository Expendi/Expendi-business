import type {
  ApprovalPasskeyStatus,
  CategoriesResponse,
  ClaimApproval,
  ClaimDetail,
  ClaimPaymentResult,
  ClaimsPage,
  ClaimsSummary,
  ExpenseDetail,
  ExpenseListQuery,
  ExpensesPage,
  ExpensesSummary,
  ExpenseStatus,
  ExpenseSummaryQuery,
  MembersResponse,
  MeResponse,
  OverviewPerson,
  SpendingOverview,
  UpdateMeRequest,
  UpdateMeResponse,
} from "@expendi-business/shared";
import {
  approvalPasskeyStatusSchema,
  categoriesResponseSchema,
  claimApprovalSchema,
  claimDetailSchema,
  claimPaymentResultSchema,
  claimsPageSchema,
  claimsSummarySchema,
  expenseDetailSchema,
  expensesPageSchema,
  expensesSummarySchema,
  membersResponseSchema,
  meResponseSchema,
  overviewPersonSchema,
  spendingOverviewSchema,
  updateMeResponseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "./api";
import type { PasskeyAssertion } from "./passkeys";

type ApiPath = `/${string}`;

/** Leaves out filters that aren't set. */
function withQuery(
  path: ApiPath,
  params: Readonly<Record<string, string | number | undefined>>,
): ApiPath {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** `GET …/expenses`' filters and page, as the dashboard sends them. */
export type ExpenseListParams = Omit<ExpenseListQuery, "limit"> & {
  limit?: number;
};

export interface ClaimQueueQuery {
  status: ExpenseStatus;
  limit?: number;
  cursor?: string | undefined;
}

/**
 * The API's customer routes (`/me`, `/organizations/*`), the same ones the
 * app calls. The API allows this site's origin through `DASHBOARD_ORIGINS`
 * and keeps every role rule itself.
 */
export interface CustomerApi {
  /** Also activates invites sent to someone who already had a login. */
  getMe: () => Promise<MeResponse>;
  updateMe: (body: UpdateMeRequest) => Promise<UpdateMeResponse>;
  getOverview: (
    organizationId: string,
    month?: string,
  ) => Promise<SpendingOverview>;
  getOverviewPerson: (
    organizationId: string,
    personId: string,
  ) => Promise<OverviewPerson>;
  /** Whether the signed-in admin has an approval passkey for money actions. */
  getApprovalPasskeyStatus: () => Promise<ApprovalPasskeyStatus>;
  listCategories: (organizationId: string) => Promise<CategoriesResponse>;
  listMembers: (organizationId: string) => Promise<MembersResponse>;
  listExpenses: (
    organizationId: string,
    query: ExpenseListParams,
  ) => Promise<ExpensesPage>;
  getExpense: (
    organizationId: string,
    expenseId: string,
  ) => Promise<ExpenseDetail>;
  /** Totals of every expense the filters match, and each kind tab's count. */
  getExpensesSummary: (
    organizationId: string,
    query: ExpenseSummaryQuery,
  ) => Promise<ExpensesSummary>;
  /** Claims waiting for approval and those whose payment failed. */
  getClaimsSummary: (organizationId: string) => Promise<ClaimsSummary>;
  listClaims: (
    organizationId: string,
    query: ClaimQueueQuery,
  ) => Promise<ClaimsPage>;
  getClaim: (organizationId: string, claimId: string) => Promise<ClaimDetail>;
  /** Approve & pay for up to 20 submitted claims: their cost and one passkey challenge. */
  prepareClaimApproval: (
    organizationId: string,
    claimIds: readonly string[],
  ) => Promise<ClaimApproval>;
  /** A new payment for a claim whose payment failed, with its own challenge. */
  prepareClaimRetry: (
    organizationId: string,
    claimId: string,
  ) => Promise<ClaimApproval>;
  confirmClaimApproval: (
    organizationId: string,
    challengeId: string,
    response: PasskeyAssertion,
  ) => Promise<ClaimPaymentResult>;
  rejectClaim: (
    organizationId: string,
    claimId: string,
    reason: string,
  ) => Promise<ClaimDetail>;
}

export function createCustomerApi(client: ApiClient): CustomerApi {
  return {
    getMe: () => client.get("/me", meResponseSchema),
    updateMe: (body) => client.patch("/me", body, updateMeResponseSchema),
    getOverview: (organizationId, month) =>
      client.get(
        `/organizations/${organizationId}/overview${month ? `?month=${encodeURIComponent(month)}` : ""}`,
        spendingOverviewSchema,
      ),
    getOverviewPerson: (organizationId, personId) =>
      client.get(
        `/organizations/${organizationId}/overview/people/${personId}`,
        overviewPersonSchema,
      ),
    getApprovalPasskeyStatus: () =>
      client.get("/me/approval-passkey", approvalPasskeyStatusSchema),
    listCategories: (organizationId) =>
      client.get(
        `/organizations/${organizationId}/categories`,
        categoriesResponseSchema,
      ),
    listMembers: (organizationId) =>
      client.get(
        `/organizations/${organizationId}/members`,
        membersResponseSchema,
      ),
    listExpenses: (organizationId, query) =>
      client.get(
        withQuery(`/organizations/${organizationId}/expenses`, query),
        expensesPageSchema,
      ),
    getExpense: (organizationId, expenseId) =>
      client.get(
        `/organizations/${organizationId}/expenses/${expenseId}`,
        expenseDetailSchema,
      ),
    getExpensesSummary: (organizationId, query) =>
      client.get(
        withQuery(`/organizations/${organizationId}/expenses/summary`, query),
        expensesSummarySchema,
      ),
    getClaimsSummary: (organizationId) =>
      client.get(
        `/organizations/${organizationId}/claims/summary`,
        claimsSummarySchema,
      ),
    listClaims: (organizationId, query) =>
      client.get(
        withQuery(`/organizations/${organizationId}/claims`, { ...query }),
        claimsPageSchema,
      ),
    getClaim: (organizationId, claimId) =>
      client.get(
        `/organizations/${organizationId}/claims/${claimId}`,
        claimDetailSchema,
      ),
    prepareClaimApproval: (organizationId, claimIds) =>
      client.post(
        `/organizations/${organizationId}/claims/approval`,
        { claimIds },
        claimApprovalSchema,
      ),
    prepareClaimRetry: (organizationId, claimId) =>
      client.post(
        `/organizations/${organizationId}/claims/${claimId}/retry`,
        undefined,
        claimApprovalSchema,
      ),
    confirmClaimApproval: (organizationId, challengeId, response) =>
      client.post(
        `/organizations/${organizationId}/claims/approval/${challengeId}/confirm`,
        { response },
        claimPaymentResultSchema,
      ),
    rejectClaim: (organizationId, claimId, reason) =>
      client.post(
        `/organizations/${organizationId}/claims/${claimId}/reject`,
        { reason },
        claimDetailSchema,
      ),
  };
}
