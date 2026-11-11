import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { FundIn, FundInRequest } from "@expendi-business/shared";
import { fundInSchema, fundInsResponseSchema } from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import { fundInPollInterval } from "./fund-in";

function fundInsPath(organizationId: string) {
  return `/organizations/${organizationId}/wallet/fund-ins` as const;
}

/** The company's fund-ins from other chains, newest first. */
export function useFundIns(organizationId: string): UseQueryResult<FundIn[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.fundIns(organizationId),
    queryFn: () => api.get(fundInsPath(organizationId), fundInsResponseSchema),
  });
}

/**
 * One fund-in, asked about again every few seconds until it's final. When
 * it completes the wallet's balance and history are fetched again.
 */
export function useFundIn(
  organizationId: string,
  fundInId: string,
): UseQueryResult<FundIn> {
  const api = useApi();
  const queryClient = useQueryClient();
  const fundIn = useQuery({
    queryKey: queryKeys.fundIn(organizationId, fundInId),
    queryFn: () =>
      api.get(`${fundInsPath(organizationId)}/${fundInId}`, fundInSchema),
    refetchInterval: (query) => fundInPollInterval(query.state.data),
  });
  const status = fundIn.data?.status;
  useEffect(() => {
    if (status !== "completed") return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.wallet(organizationId),
      exact: true,
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.walletHistory(organizationId),
    });
  }, [status, organizationId, queryClient]);
  return fundIn;
}

/** Asks for a one-time deposit address on another chain. */
export function useStartFundIn(
  organizationId: string,
): UseMutationResult<FundIn, Error, FundInRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(fundInsPath(organizationId), request, fundInSchema),
    onSuccess: (fundIn) => {
      queryClient.setQueryData(
        queryKeys.fundIn(organizationId, fundIn.id),
        fundIn,
      );
      return queryClient.invalidateQueries({
        queryKey: queryKeys.fundIns(organizationId),
        exact: true,
      });
    },
  });
}
