import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { WalletResponse, WalletSetup } from "@expendi-business/shared";
import {
  walletResponseSchema,
  walletSetupSchema,
} from "@expendi-business/shared";

import { ApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

export function useCompanyWallet(
  organizationId: string,
): UseQueryResult<WalletResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.wallet(organizationId),
    queryFn: () =>
      api.get(`/organizations/${organizationId}/wallet`, walletResponseSchema),
  });
}

/** A 404 means the company has no wallet row at all; `POST …/wallet` creates it. */
export function isMissingWallet(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Resumes or starts the company's wallet setup; safe to repeat. */
export function useFinishWalletSetup(
  organizationId: string,
): UseMutationResult<WalletSetup, Error, void> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(
        `/organizations/${organizationId}/wallet`,
        undefined,
        walletSetupSchema,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.wallet(organizationId),
      }),
  });
}
