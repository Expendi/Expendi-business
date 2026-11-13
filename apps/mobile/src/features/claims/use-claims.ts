import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  CategoriesResponse,
  ClaimDetail,
  ClaimsPage,
  ReceiptSmsRequest,
  ReceiptSmsResponse,
  SubmitClaimRequest,
  UpdateClaimRequest,
} from "@expendi-business/shared";
import {
  categoriesResponseSchema,
  claimDetailSchema,
  claimsPageSchema,
  paymentPollInterval,
  receiptSmsResponseSchema,
} from "@expendi-business/shared";

import { claimPagesStatuses, claimStatuses } from "~/lib/payment-poll";
import { queryKeys } from "~/lib/query-keys";
import { useRefreshWhenPaymentsSettle } from "~/lib/use-payments-settled";
import { useApi } from "~/providers/api-provider";

const CATEGORIES_STALE_MS = 5 * 60_000;

function claimsPath(organizationId: string) {
  return `/organizations/${organizationId}/claims` as const;
}

/**
 * Newest first; employees get their own claims, admins everyone's. Asked
 * about again while one is being paid.
 */
export function useClaimList(
  organizationId: string,
): UseInfiniteQueryResult<InfiniteData<ClaimsPage>> {
  const api = useApi();
  const claims = useInfiniteQuery({
    queryKey: queryKeys.claimList(organizationId),
    queryFn: ({ pageParam }) =>
      api.get(
        pageParam === null
          ? claimsPath(organizationId)
          : `${claimsPath(organizationId)}?cursor=${encodeURIComponent(pageParam)}`,
        claimsPageSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      paymentPollInterval(claimPagesStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    claimPagesStatuses(claims.data),
    "claims",
    organizationId,
  );
  return claims;
}

export function useClaim(
  organizationId: string,
  claimId: string,
): UseQueryResult<ClaimDetail> {
  const api = useApi();
  const claim = useQuery({
    queryKey: queryKeys.claim(organizationId, claimId),
    queryFn: () =>
      api.get(`${claimsPath(organizationId)}/${claimId}`, claimDetailSchema),
    refetchInterval: (query) =>
      paymentPollInterval(claimStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    claimStatuses(claim.data),
    "claims",
    organizationId,
  );
  return claim;
}

export function useCategories(
  organizationId: string,
): UseQueryResult<CategoriesResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/categories`,
        categoriesResponseSchema,
      ),
    staleTime: CATEGORIES_STALE_MS,
  });
}

function useInvalidateClaims(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.claims(organizationId),
    });
}

export function useSubmitClaim(
  organizationId: string,
): UseMutationResult<ClaimDetail, Error, SubmitClaimRequest> {
  const api = useApi();
  const invalidate = useInvalidateClaims(organizationId);
  return useMutation({
    mutationFn: (claim) =>
      api.post(claimsPath(organizationId), claim, claimDetailSchema),
    onSuccess: invalidate,
  });
}

/** Saving a rejected claim resubmits it. */
export function useUpdateClaim(
  organizationId: string,
  claimId: string,
): UseMutationResult<ClaimDetail, Error, UpdateClaimRequest> {
  const api = useApi();
  const invalidate = useInvalidateClaims(organizationId);
  return useMutation({
    mutationFn: (changes) =>
      api.patch(
        `${claimsPath(organizationId)}/${claimId}`,
        changes,
        claimDetailSchema,
      ),
    onSuccess: invalidate,
  });
}

/** Keeps a pasted M-Pesa SMS as the claim's evidence; the API reads it again. */
export function useRegisterSms(
  organizationId: string,
): UseMutationResult<ReceiptSmsResponse, Error, ReceiptSmsRequest> {
  const api = useApi();
  return useMutation({
    mutationFn: (request) =>
      api.post(
        `/organizations/${organizationId}/receipts/sms`,
        request,
        receiptSmsResponseSchema,
      ),
  });
}
