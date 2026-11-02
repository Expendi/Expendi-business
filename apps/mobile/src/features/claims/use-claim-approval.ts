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
  ClaimApproval,
  ClaimDetail,
  ClaimPaymentResult,
  ClaimsPage,
  ExpenseStatus,
  RejectClaimRequest,
} from "@expendi-business/shared";
import {
  claimApprovalSchema,
  claimDetailSchema,
  claimPaymentResultSchema,
  claimsPageSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import type { ApiClient } from "~/lib/api";
import { describeApprovalError, usePasskeyApproval } from "~/features/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import { isChallengeFresh, sameCost, topUpFrom } from "./payment";

/**
 * Approve & pay, retry and reject (spec §6.7, §6.8): the API prepares the
 * claim's payout and a passkey challenge bound to it, the admin reviews the
 * cost, signs with their passkey, and the API approves and pays it once.
 */

const claimsPath = (organizationId: string) =>
  `/organizations/${organizationId}/claims` as const;

/** The cost changed between the review and the passkey prompt. */
export class CostChangedError extends Error {
  override readonly name = "CostChangedError";

  constructor() {
    super(
      "The cost changed since you reviewed it. Nothing was sent. Review it again.",
    );
  }
}

/** A prepared payment and when it was prepared, to know if its challenge is still good. */
export interface PreparedPayment {
  readonly approval: ClaimApproval;
  readonly preparedAt: number;
}

function preparePayment(
  api: ApiClient,
  organizationId: string,
  claimId: string,
  retry: boolean,
): Promise<ClaimApproval> {
  const path = claimsPath(organizationId);
  return retry
    ? api.post(`${path}/${claimId}/retry`, undefined, claimApprovalSchema)
    : api.post(
        `${path}/approval`,
        { claimIds: [claimId] },
        claimApprovalSchema,
      );
}

/**
 * Prepares one claim's payment (or its retry) when the screen opens. The
 * API returns the same payout each time, so opening the screen again never
 * creates a second one; it never refetches on its own.
 */
export function useClaimPayment(
  organizationId: string,
  claimId: string,
  retry: boolean,
): UseQueryResult<PreparedPayment> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.claimPayment(organizationId, claimId, retry),
    queryFn: async () => ({
      approval: await preparePayment(api, organizationId, claimId, retry),
      preparedAt: Date.now(),
    }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Signs the prepared challenge, or a fresh one for exactly the same cost. */
export function usePayClaim(
  organizationId: string,
  claimId: string,
  retry: boolean,
): UseMutationResult<
  ApprovalOutcome<ClaimPaymentResult>,
  Error,
  PreparedPayment
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return usePasskeyApproval({
    request: async ({ approval, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return approval;
      const fresh = await preparePayment(api, organizationId, claimId, retry);
      if (!sameCost(approval, fresh)) throw new CostChangedError();
      return fresh;
    },
    confirm: (challenge, response) =>
      api.post(
        `${claimsPath(organizationId)}/approval/${challenge.challengeId}/confirm`,
        { response },
        claimPaymentResultSchema,
      ),
    onApproved: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.claims(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.wallet(organizationId),
        }),
      ]),
  });
}

/** What to tell the admin when Approve & pay fails, "Top up KES X" first. */
export function describePaymentError(error: unknown): string {
  if (error instanceof CostChangedError) return error.message;
  return topUpFrom(error) ?? describeApprovalError(error);
}

/** Rejecting needs a reason the employee will see (spec §5). */
export function useRejectClaim(
  organizationId: string,
  claimId: string,
): UseMutationResult<ClaimDetail, Error, RejectClaimRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(
        `${claimsPath(organizationId)}/${claimId}/reject`,
        request,
        claimDetailSchema,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.claims(organizationId),
      }),
  });
}

/** Every claim in one status, newest first: the admin's queue. */
export function useClaimQueue(
  organizationId: string,
  status: ExpenseStatus,
): UseInfiniteQueryResult<InfiniteData<ClaimsPage>> {
  const api = useApi();
  const path = `${claimsPath(organizationId)}?status=${status}` as const;
  return useInfiniteQuery({
    queryKey: queryKeys.claimQueue(organizationId, status),
    queryFn: ({ pageParam }) =>
      api.get(
        pageParam === null
          ? path
          : `${path}&cursor=${encodeURIComponent(pageParam)}`,
        claimsPageSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}
