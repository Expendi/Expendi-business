import type { InfiniteData } from "@tanstack/react-query";
import { infiniteQueryOptions } from "@tanstack/react-query";

import type { ExpensesPage } from "@expendi-business/shared";
import {
  isPaymentInFlight,
  paymentPollInterval,
} from "@expendi-business/shared";

import type { CustomerApi, ExpenseListParams } from "~/lib/customer-api";
import { queryKeys } from "~/lib/query-keys";

const statuses = (list: InfiniteData<ExpensesPage> | undefined) =>
  (list?.pages ?? []).flatMap((page) =>
    page.expenses.map((expense) => expense.status),
  );

/** How many reimbursements among the loaded rows are being paid. */
export function claimsBeingPaid(
  list: InfiniteData<ExpensesPage> | undefined,
): number {
  return statuses(list).filter((status) =>
    isPaymentInFlight({ claims: [status] }),
  ).length;
}

/**
 * The expenses under the filters, a page at a time. Asked about again
 * every few seconds while a reimbursement in them is being paid.
 */
export function expenseListQuery(
  api: Pick<CustomerApi, "listExpenses">,
  organizationId: string,
  listQuery: ExpenseListParams,
) {
  return infiniteQueryOptions({
    queryKey: queryKeys.expenseList(organizationId, listQuery),
    queryFn: ({ pageParam }) =>
      api.listExpenses(organizationId, {
        ...listQuery,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      paymentPollInterval({ claims: statuses(query.state.data) }),
  });
}
