import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { WalletHistoryResponse } from "@expendi-business/shared";
import {
  paymentPollInterval,
  walletHistoryResponseSchema,
} from "@expendi-business/shared";

import { walletHistoryStatuses } from "~/lib/payment-poll";
import { queryKeys } from "~/lib/query-keys";
import { useRefreshWhenPaymentsSettle } from "~/lib/use-payments-settled";
import { useApi } from "~/providers/api-provider";

type WalletHistoryData = InfiniteData<WalletHistoryResponse, string | null>;

/**
 * The wallet's ledger, newest first, a page at a time; asked about again
 * while a payout in it is on its way.
 */
export function useWalletHistory(
  organizationId: string,
): UseInfiniteQueryResult<WalletHistoryData> {
  const api = useApi();
  const history: UseInfiniteQueryResult<WalletHistoryData> = useInfiniteQuery({
    queryKey: queryKeys.walletHistory(organizationId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get(
        `/organizations/${organizationId}/wallet/history${pageParam ? `?before=${pageParam}` : ""}`,
        walletHistoryResponseSchema,
      ),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      paymentPollInterval(walletHistoryStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    walletHistoryStatuses(history.data),
    "wallet_history",
    organizationId,
  );
  return history;
}
