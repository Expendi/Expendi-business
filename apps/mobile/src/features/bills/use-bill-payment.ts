import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { BillPayment, BillPaymentResult } from "@expendi-business/shared";
import {
  billPaymentResultSchema,
  billPaymentSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import type { ApiClient } from "~/lib/api";
import { describeApprovalError, usePasskeyApproval } from "~/features/approval";
import { isChallengeFresh, topUpFrom } from "~/features/claims/payment";
import { CostChangedError } from "~/features/claims/use-claim-approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import { joinBillIds, sameBillCost } from "./bill-payment";

/**
 * Pay, Pay all and retry (spec §6.20): the API prepares each bill's payout
 * and one passkey challenge for them all, the admin reviews the cost and
 * signs, and the API pays each bill once.
 */

const billsPath = (organizationId: string) =>
  `/organizations/${organizationId}/bills` as const;

export interface BillPaymentRequest {
  readonly billIds: readonly string[];
  /** A retry of one bill whose payment failed. */
  readonly retry: boolean;
  /** Only after the admin confirmed the 24-hour warning (spec §6.19). */
  readonly secondConfirmation: boolean;
}

export interface PreparedBillPayment {
  readonly payment: BillPayment;
  readonly preparedAt: number;
}

function preparePayment(
  api: ApiClient,
  organizationId: string,
  { billIds, retry, secondConfirmation }: BillPaymentRequest,
): Promise<BillPayment> {
  const path = billsPath(organizationId);
  const [billId] = billIds;
  return retry && billId !== undefined
    ? api.post(
        `${path}/${billId}/retry`,
        { secondConfirmation },
        billPaymentSchema,
      )
    : api.post(
        `${path}/payment`,
        { billIds, secondConfirmation },
        billPaymentSchema,
      );
}

/**
 * Prepares the payment when the pay screen opens. The API returns the same
 * payouts each time, so opening it again never prepares a second set; it
 * never refetches on its own.
 */
export function useBillPayment(
  organizationId: string,
  request: BillPaymentRequest,
): UseQueryResult<PreparedBillPayment> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.billPayment(
      organizationId,
      joinBillIds(request.billIds),
      request.retry,
      request.secondConfirmation,
    ),
    queryFn: async () => ({
      payment: await preparePayment(api, organizationId, request),
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
export function usePayBills(
  organizationId: string,
  request: BillPaymentRequest,
): UseMutationResult<
  ApprovalOutcome<BillPaymentResult>,
  Error,
  PreparedBillPayment
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return usePasskeyApproval({
    request: async ({ payment, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return payment;
      const fresh = await preparePayment(api, organizationId, request);
      if (!sameBillCost(payment, fresh)) throw new CostChangedError();
      return fresh;
    },
    confirm: (challenge, response) =>
      api.post(
        `${billsPath(organizationId)}/payment/${challenge.challengeId}/confirm`,
        { response },
        billPaymentResultSchema,
      ),
    onApproved: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.bills(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.recurringItems(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.wallet(organizationId),
        }),
      ]),
  });
}

/** What to tell the admin when paying fails, "Top up KES X" first. */
export function describeBillPaymentError(error: unknown): string {
  if (error instanceof CostChangedError) return error.message;
  return topUpFrom(error) ?? describeApprovalError(error);
}
