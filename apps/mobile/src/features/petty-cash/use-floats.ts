import type {
  QueryClient,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CloseFloatRequest,
  FloatApproval,
  FloatDetail,
  FloatPaymentResult,
  FloatSpendingResult,
  FloatsResponse,
  IssueFloatRequest,
  RecordFloatReturnRequest,
  RecordFloatSpendingRequest,
  TopUpFloatRequest,
} from "@expendi-business/shared";
import {
  floatApprovalSchema,
  floatDetailSchema,
  floatPaymentResultSchema,
  floatSpendingResultSchema,
  floatsResponseSchema,
  paymentPollInterval,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import type { ApiClient } from "~/lib/api";
import { describeApprovalError, usePasskeyApproval } from "~/features/approval";
import { isChallengeFresh, topUpFrom } from "~/features/claims/payment";
import { floatListStatuses, floatStatuses } from "~/lib/payment-poll";
import { queryKeys } from "~/lib/query-keys";
import { useRefreshWhenPaymentsSettle } from "~/lib/use-payments-settled";
import { useApi } from "~/providers/api-provider";
import { sameFloatCost } from "./float-display";

/**
 * Petty cash floats (spec §6.22): the holder's balance and spending, and
 * the admin's issue, top-up, Approve & pay, return and close.
 */

const floatsPath = (organizationId: string) =>
  `/organizations/${organizationId}/floats` as const;

/**
 * Admins get every float; `mine` narrows the list to the caller's own.
 * Asked about again while money is on its way to a holder.
 */
export function useFloats(
  organizationId: string,
  { mine }: { mine: boolean },
): UseQueryResult<FloatsResponse> {
  const api = useApi();
  const floats = useQuery({
    queryKey: queryKeys.floatList(organizationId, mine),
    queryFn: () =>
      api.get(
        mine
          ? `${floatsPath(organizationId)}?mine=true`
          : floatsPath(organizationId),
        floatsResponseSchema,
      ),
    refetchInterval: (query) =>
      paymentPollInterval(floatListStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    floatListStatuses(floats.data),
    "floats",
    organizationId,
  );
  return floats;
}

export function useFloat(
  organizationId: string,
  floatId: string,
): UseQueryResult<FloatDetail> {
  const api = useApi();
  const float = useQuery({
    queryKey: queryKeys.float(organizationId, floatId),
    queryFn: () =>
      api.get(`${floatsPath(organizationId)}/${floatId}`, floatDetailSchema),
    refetchInterval: (query) =>
      paymentPollInterval(floatStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    floatStatuses(float.data),
    "floats",
    organizationId,
  );
  return float;
}

function invalidateFloats(
  queryClient: QueryClient,
  organizationId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.floats(organizationId),
  });
}

/** "Paid from petty cash"; an overspend also submits a claim, so claims refresh too. */
export function useRecordFloatSpending(
  organizationId: string,
  floatId: string,
): UseMutationResult<FloatSpendingResult, Error, RecordFloatSpendingRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(
        `${floatsPath(organizationId)}/${floatId}/spending`,
        request,
        floatSpendingResultSchema,
      ),
    onSuccess: () =>
      Promise.all([
        invalidateFloats(queryClient, organizationId),
        queryClient.invalidateQueries({
          queryKey: queryKeys.claims(organizationId),
        }),
      ]),
  });
}

/** A prepared payment and when it was prepared, to know if its challenge is still good. */
export interface PreparedFloatPayment {
  readonly approval: FloatApproval;
  readonly preparedAt: number;
}

/** Keeps a just-prepared payment for the pay screen, so opening it prepares nothing again. */
function rememberPayment(
  queryClient: QueryClient,
  organizationId: string,
  approval: FloatApproval,
): void {
  queryClient.setQueryData<PreparedFloatPayment>(
    queryKeys.floatPayment(
      organizationId,
      approval.float.id,
      approval.movement.id,
    ),
    { approval, preparedAt: Date.now() },
  );
}

/** Opens a float and prepares its first payment; the admin then approves it with their passkey. */
export function useIssueFloat(
  organizationId: string,
): UseMutationResult<FloatApproval, Error, IssueFloatRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(floatsPath(organizationId), request, floatApprovalSchema),
    onSuccess: async (approval) => {
      rememberPayment(queryClient, organizationId, approval);
      await invalidateFloats(queryClient, organizationId);
    },
  });
}

export function useTopUpFloat(
  organizationId: string,
  floatId: string,
): UseMutationResult<FloatApproval, Error, TopUpFloatRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(
        `${floatsPath(organizationId)}/${floatId}/top-ups`,
        request,
        floatApprovalSchema,
      ),
    onSuccess: async (approval) => {
      rememberPayment(queryClient, organizationId, approval);
      await invalidateFloats(queryClient, organizationId);
    },
  });
}

function prepareMovement(
  api: ApiClient,
  organizationId: string,
  floatId: string,
  movementId: string,
): Promise<FloatApproval> {
  return api.post(
    `${floatsPath(organizationId)}/${floatId}/movements/${movementId}/approval`,
    undefined,
    floatApprovalSchema,
  );
}

/**
 * The payment waiting for approval, or its retry after a failure. The
 * issue or top-up screen already prepared it; otherwise opening the screen
 * prepares it, and the API returns the same payment each time.
 */
export function useFloatPayment(
  organizationId: string,
  floatId: string,
  movementId: string,
): UseQueryResult<PreparedFloatPayment> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.floatPayment(organizationId, floatId, movementId),
    queryFn: async () => ({
      approval: await prepareMovement(api, organizationId, floatId, movementId),
      preparedAt: Date.now(),
    }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** The cost changed between the review and the passkey prompt. */
export class FloatCostChangedError extends Error {
  override readonly name = "FloatCostChangedError";

  constructor() {
    super(
      "The cost changed since you reviewed it. Nothing was sent. Review it again.",
    );
  }
}

/** Signs the prepared challenge, or a fresh one for exactly the same cost. */
export function usePayFloat(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<FloatPaymentResult>,
  Error,
  PreparedFloatPayment
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return usePasskeyApproval({
    request: async ({ approval, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return approval;
      const fresh = await prepareMovement(
        api,
        organizationId,
        approval.float.id,
        approval.movement.id,
      );
      if (!sameFloatCost(approval, fresh)) throw new FloatCostChangedError();
      return fresh;
    },
    confirm: (challenge, response) =>
      api.post(
        `${floatsPath(organizationId)}/approval/${challenge.challengeId}/confirm`,
        { response },
        floatPaymentResultSchema,
      ),
    onApproved: () =>
      Promise.all([
        invalidateFloats(queryClient, organizationId),
        queryClient.invalidateQueries({
          queryKey: queryKeys.wallet(organizationId),
        }),
      ]),
  });
}

/** What to tell the admin when paying a float fails, "Top up KES X" first. */
export function describeFloatPaymentError(error: unknown): string {
  if (error instanceof FloatCostChangedError) return error.message;
  return topUpFrom(error) ?? describeApprovalError(error);
}

export function useRecordFloatReturn(
  organizationId: string,
  floatId: string,
): UseMutationResult<FloatDetail, Error, RecordFloatReturnRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(
        `${floatsPath(organizationId)}/${floatId}/returns`,
        request,
        floatDetailSchema,
      ),
    onSuccess: () => invalidateFloats(queryClient, organizationId),
  });
}

export function useCloseFloat(
  organizationId: string,
  floatId: string,
): UseMutationResult<FloatDetail, Error, CloseFloatRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(
        `${floatsPath(organizationId)}/${floatId}/close`,
        request,
        floatDetailSchema,
      ),
    onSuccess: () => invalidateFloats(queryClient, organizationId),
  });
}
