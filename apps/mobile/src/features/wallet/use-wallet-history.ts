import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { WalletHistoryResponse } from "@expendi-business/shared";
import { walletHistoryResponseSchema } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

/** The wallet's ledger, newest first, a page at a time. */
export function useWalletHistory(
  organizationId: string,
): UseInfiniteQueryResult<InfiniteData<WalletHistoryResponse, string | null>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.walletHistory(organizationId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get(
        `/organizations/${organizationId}/wallet/history${pageParam ? `?before=${pageParam}` : ""}`,
        walletHistoryResponseSchema,
      ),
    getNextPageParam: (page) => page.nextCursor,
  });
}
