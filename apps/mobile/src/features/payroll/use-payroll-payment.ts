import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  PayrollMargin,
  PayrollMarginChallenge,
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";
import {
  payrollMarginChallengeSchema,
  payrollMarginSchema,
  payrollRunDetailSchema,
  payrollRunPaymentSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import type { ApiClient } from "~/lib/api";
import { usePasskeyApproval } from "~/features/approval";
import { isChallengeFresh } from "~/features/claims/payment";
import { CostChangedError } from "~/features/claims/use-claim-approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import { samePayrollCost } from "./payroll-payment";

/**
 * Approve & pay all, one person's retry (spec §6.21) and the payroll
 * margin (spec §7.4), each confirmed with the admin's passkey.
 */

const runPath = (organizationId: string, runId: string) =>
  `/organizations/${organizationId}/payroll-runs/${runId}` as const;
const marginPath = (organizationId: string) =>
  `/organizations/${organizationId}/settings/payroll-margin` as const;

export interface PayrollPaymentRequest {
  readonly runId: string;
  /** One person whose payment failed; null pays the whole draft run. */
  readonly retryBillId: string | null;
  /** Only after the admin confirmed the 24-hour warning (spec §6.19). */
  readonly secondConfirmation: boolean;
}

export interface PreparedPayrollPayment {
  readonly payment: PayrollRunPayment;
  readonly preparedAt: number;
}

function preparePayment(
  api: ApiClient,
  organizationId: string,
  { runId, retryBillId, secondConfirmation }: PayrollPaymentRequest,
): Promise<PayrollRunPayment> {
  const path = runPath(organizationId, runId);
  return api.post(
    retryBillId === null
      ? `${path}/payment`
      : `${path}/payments/${retryBillId}/retry`,
    { secondConfirmation },
    payrollRunPaymentSchema,
  );
}

/** Prepares the payment when the screen opens; never refetches on its own. */
export function usePayrollPayment(
  organizationId: string,
  request: PayrollPaymentRequest,
): UseQueryResult<PreparedPayrollPayment> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.payrollPayment(
      organizationId,
      request.runId,
      request.retryBillId,
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
export function usePayPayroll(
  organizationId: string,
  request: PayrollPaymentRequest,
): UseMutationResult<
  ApprovalOutcome<PayrollRunDetail>,
  Error,
  PreparedPayrollPayment
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return usePasskeyApproval({
    request: async ({ payment, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return payment;
      const fresh = await preparePayment(api, organizationId, request);
      if (!samePayrollCost(payment, fresh)) throw new CostChangedError();
      return fresh;
    },
    confirm: (challenge, response) =>
      api.post(
        `${runPath(organizationId, request.runId)}/payment/${challenge.challengeId}/confirm`,
        { response },
        payrollRunDetailSchema,
      ),
    onApproved: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.payroll(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.wallet(organizationId),
        }),
      ]),
  });
}

export function usePayrollMargin(
  organizationId: string,
): UseQueryResult<PayrollMargin> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.payrollMargin(organizationId),
    queryFn: () => api.get(marginPath(organizationId), payrollMarginSchema),
  });
}

/** A new margin needs the admin's passkey, bound to exactly that margin. */
export function useChangePayrollMargin(
  organizationId: string,
): UseMutationResult<ApprovalOutcome<PayrollMargin>, Error, number> {
  const api = useApi();
  const queryClient = useQueryClient();
  return usePasskeyApproval({
    request: (marginPct: number): Promise<PayrollMarginChallenge> =>
      api.post(
        marginPath(organizationId),
        { marginPct },
        payrollMarginChallengeSchema,
      ),
    confirm: (challenge, response) =>
      api.post(
        `${marginPath(organizationId)}/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        payrollMarginSchema,
      ),
    onApproved: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.payrollMargin(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.payroll(organizationId),
        }),
      ]),
  });
}
