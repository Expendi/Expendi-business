"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CreateSalaryRequest,
  PayrollMargin,
  PayrollMarginChallenge,
  PayrollRun,
  PayrollRunDetail,
  PayrollRunPayment,
  Salary,
  SalaryAmountChallenge,
  UpdateSalaryRequest,
} from "@expendi-business/shared";
import {
  payrollMarginChallengeSchema,
  payrollMarginSchema,
  payrollRunDetailSchema,
  payrollRunsResponseSchema,
  salariesResponseSchema,
  salaryAmountChallengeSchema,
  salarySchema,
} from "@expendi-business/shared";

import type { DraftChange, PayrollPaymentRequest } from "./payroll-payment";
import type { ApiClient } from "~/lib/api";
import type { ApprovalOutcome, PasskeyApprovalSteps } from "~/lib/approval";
import { CostChangedError } from "~/features/bills/bill-payment";
import { billKeys, payrollKeys, walletPrefix } from "~/features/payment-keys";
import { isChallengeFresh } from "~/lib/approval";
import { useApi } from "~/lib/use-api";
import { usePasskeyApproval } from "~/lib/use-approval";
import {
  changeDraftRun,
  confirmPayrollPayment,
  preparePayrollPayment,
  samePayrollCost,
} from "./payroll-payment";

/**
 * Salaries, payroll runs and the payroll margin (T38, T39): admins act,
 * accountants read everything, salaries included (spec §6.14). Net pay,
 * the margin and paying a run each need the admin's passkey.
 */

const salariesPath = (organizationId: string) =>
  `/organizations/${organizationId}/salaries` as const;
const runsPath = (organizationId: string) =>
  `/organizations/${organizationId}/payroll-runs` as const;
const marginPath = (organizationId: string) =>
  `/organizations/${organizationId}/settings/payroll-margin` as const;

/** New net pay, bound to exactly this salary and amount. */
export function salaryAmountSteps(
  api: ApiClient,
  organizationId: string,
  salaryId: string,
): PasskeyApprovalSteps<string, SalaryAmountChallenge, Salary> {
  const path = salariesPath(organizationId);
  return {
    request: (amountKes) =>
      api.post(
        `${path}/${salaryId}/amount`,
        { amountKes },
        salaryAmountChallengeSchema,
      ),
    confirm: (challenge, response) =>
      api.post(
        `${path}/amount-changes/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        salarySchema,
      ),
  };
}

/** A new payroll margin, bound to exactly that percentage. */
export function payrollMarginSteps(
  api: ApiClient,
  organizationId: string,
): PasskeyApprovalSteps<number, PayrollMarginChallenge, PayrollMargin> {
  const path = marginPath(organizationId);
  return {
    request: (marginPct) =>
      api.post(path, { marginPct }, payrollMarginChallengeSchema),
    confirm: (challenge, response) =>
      api.post(
        `${path}/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        payrollMarginSchema,
      ),
  };
}

/** Salaries, current first. */
export function useSalaries(organizationId: string): UseQueryResult<Salary[]> {
  const api = useApi();
  return useQuery({
    queryKey: payrollKeys.salaries(organizationId),
    queryFn: () =>
      api.get(salariesPath(organizationId), salariesResponseSchema),
  });
}

/** Payroll runs, latest pay date first. */
export function usePayrollRuns(
  organizationId: string,
): UseQueryResult<PayrollRun[]> {
  const api = useApi();
  return useQuery({
    queryKey: payrollKeys.runs(organizationId),
    queryFn: () => api.get(runsPath(organizationId), payrollRunsResponseSchema),
  });
}

export function usePayrollRun(
  organizationId: string,
  runId: string,
): UseQueryResult<PayrollRunDetail> {
  const api = useApi();
  return useQuery({
    queryKey: payrollKeys.run(organizationId, runId),
    queryFn: () =>
      api.get(`${runsPath(organizationId)}/${runId}`, payrollRunDetailSchema),
  });
}

export function usePayrollMargin(
  organizationId: string,
): UseQueryResult<PayrollMargin> {
  const api = useApi();
  return useQuery({
    queryKey: payrollKeys.margin(organizationId),
    queryFn: () => api.get(marginPath(organizationId), payrollMarginSchema),
  });
}

/** Payroll payments are bills, so bills refresh with the runs. */
function useInvalidatePayroll(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [payrollKeys.all(organizationId), billKeys.all(organizationId)].map(
        (queryKey) => queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

export function useCreateSalary(
  organizationId: string,
): UseMutationResult<Salary, Error, CreateSalaryRequest> {
  const api = useApi();
  const invalidate = useInvalidatePayroll(organizationId);
  return useMutation({
    mutationFn: (salary) =>
      api.post(salariesPath(organizationId), salary, salarySchema),
    onSuccess: invalidate,
  });
}

/** Pay day or category; no passkey needed. */
export function useUpdateSalary(
  organizationId: string,
  salaryId: string,
): UseMutationResult<Salary, Error, UpdateSalaryRequest> {
  const api = useApi();
  const invalidate = useInvalidatePayroll(organizationId);
  return useMutation({
    mutationFn: (changes) =>
      api.patch(
        `${salariesPath(organizationId)}/${salaryId}`,
        changes,
        salarySchema,
      ),
    onSuccess: invalidate,
  });
}

/**
 * New net pay, confirmed with the admin's passkey (spec §7.4). Backing out
 * of the prompt is `cancelled` and changes nothing.
 */
export function useChangeSalaryAmount(
  organizationId: string,
  salaryId: string,
): UseMutationResult<ApprovalOutcome<Salary>, Error, string> {
  const api = useApi();
  const invalidate = useInvalidatePayroll(organizationId);
  return usePasskeyApproval({
    ...salaryAmountSteps(api, organizationId, salaryId),
    onApproved: invalidate,
  });
}

export function useEndSalary(
  organizationId: string,
  salaryId: string,
): UseMutationResult<Salary, Error, void> {
  const api = useApi();
  const invalidate = useInvalidatePayroll(organizationId);
  return useMutation({
    mutationFn: () =>
      api.post(
        `${salariesPath(organizationId)}/${salaryId}/end`,
        undefined,
        salarySchema,
      ),
    onSuccess: invalidate,
  });
}

/** A new margin re-caps draft runs, so runs refresh too. */
export function useChangePayrollMargin(
  organizationId: string,
): UseMutationResult<ApprovalOutcome<PayrollMargin>, Error, number> {
  const api = useApi();
  const invalidate = useInvalidatePayroll(organizationId);
  return usePasskeyApproval({
    ...payrollMarginSteps(api, organizationId),
    onApproved: invalidate,
  });
}

export function useChangeDraftRun(
  organizationId: string,
  runId: string,
): UseMutationResult<PayrollRunDetail, Error, DraftChange> {
  const api = useApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePayroll(organizationId);
  return useMutation({
    mutationFn: (change) => changeDraftRun(api, organizationId, runId, change),
    onSuccess: (run) => {
      queryClient.setQueryData(payrollKeys.run(organizationId, run.id), run);
      return invalidate();
    },
  });
}

export interface PreparedPayrollPayment {
  readonly request: PayrollPaymentRequest;
  readonly payment: PayrollRunPayment;
  readonly preparedAt: number;
}

export function usePreparePayrollPayment(
  organizationId: string,
): UseMutationResult<PreparedPayrollPayment, Error, PayrollPaymentRequest> {
  const api = useApi();
  return useMutation({
    mutationFn: async (request) => ({
      request,
      payment: await preparePayrollPayment(api, organizationId, request),
      preparedAt: Date.now(),
    }),
  });
}

/** Signs the prepared challenge, or a fresh one for exactly the same cost. */
export function usePayPayroll(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<PayrollRunDetail>,
  Error,
  PreparedPayrollPayment
> {
  const api = useApi();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePayroll(organizationId);
  return usePasskeyApproval<
    PreparedPayrollPayment,
    PayrollRunPayment,
    PayrollRunDetail
  >({
    request: async ({ request, payment, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return payment;
      const fresh = await preparePayrollPayment(api, organizationId, request);
      if (!samePayrollCost(payment, fresh)) throw new CostChangedError(fresh);
      return fresh;
    },
    confirm: (challenge, response) =>
      confirmPayrollPayment(
        api,
        organizationId,
        challenge.runId,
        challenge.challengeId,
        response,
      ),
    onApproved: async (run) => {
      queryClient.setQueryData(payrollKeys.run(organizationId, run.id), run);
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({
          queryKey: walletPrefix(organizationId),
        }),
      ]);
    },
  });
}
