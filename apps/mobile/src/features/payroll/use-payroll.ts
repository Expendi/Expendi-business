import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  AddPayrollOneOffRequest,
  AdjustPayrollPaymentRequest,
  CreateSalaryRequest,
  MySalaryPayment,
  PayrollRun,
  PayrollRunDetail,
  Salary,
  SalaryAmountChallenge,
  UpdateSalaryRequest,
} from "@expendi-business/shared";
import {
  mySalaryPaymentsResponseSchema,
  payrollRunDetailSchema,
  payrollRunsResponseSchema,
  salariesResponseSchema,
  salaryAmountChallengeSchema,
  salarySchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/features/approval";
import { usePasskeyApproval } from "~/features/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

const salariesPath = (organizationId: string) =>
  `/organizations/${organizationId}/salaries` as const;
const runsPath = (organizationId: string) =>
  `/organizations/${organizationId}/payroll-runs` as const;

/** Salaries, current first. Admins only (spec §4). */
export function useSalaries(organizationId: string): UseQueryResult<Salary[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.salaryList(organizationId),
    queryFn: () =>
      api.get(salariesPath(organizationId), salariesResponseSchema),
  });
}

export function useSalary(
  organizationId: string,
  salaryId: string,
): UseQueryResult<Salary> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.salary(organizationId, salaryId),
    queryFn: () =>
      api.get(`${salariesPath(organizationId)}/${salaryId}`, salarySchema),
  });
}

/** A salary change can draft or change a run, so salaries and runs both refresh. */
function useInvalidatePayroll(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.payroll(organizationId),
    });
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
  const path = salariesPath(organizationId);
  return usePasskeyApproval({
    request: (amountKes: string): Promise<SalaryAmountChallenge> =>
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

/** Latest pay date first. Admins only. */
export function usePayrollRuns(
  organizationId: string,
): UseQueryResult<PayrollRun[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.payrollRunList(organizationId),
    queryFn: () => api.get(runsPath(organizationId), payrollRunsResponseSchema),
  });
}

export function usePayrollRun(
  organizationId: string,
  runId: string,
): UseQueryResult<PayrollRunDetail> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.payrollRun(organizationId, runId),
    queryFn: () =>
      api.get(`${runsPath(organizationId)}/${runId}`, payrollRunDetailSchema),
  });
}

function useStoreRun(organizationId: string) {
  const queryClient = useQueryClient();
  return (run: PayrollRunDetail) => {
    queryClient.setQueryData(queryKeys.payrollRun(organizationId, run.id), run);
    return queryClient.invalidateQueries({
      queryKey: queryKeys.payrollRunList(organizationId),
    });
  };
}

export type DraftChange =
  | {
      readonly action: "adjust";
      readonly billId: string;
      readonly request: AdjustPayrollPaymentRequest;
    }
  | {
      readonly action: "leave_out";
      readonly billId: string;
      readonly reason: string;
    }
  | { readonly action: "one_off"; readonly request: AddPayrollOneOffRequest };

/** Changes a draft run for this run only; each change needs a reason. */
export function useChangeDraftRun(
  organizationId: string,
  runId: string,
): UseMutationResult<PayrollRunDetail, Error, DraftChange> {
  const api = useApi();
  const storeRun = useStoreRun(organizationId);
  const path = `${runsPath(organizationId)}/${runId}` as const;
  return useMutation({
    mutationFn: (change) => {
      switch (change.action) {
        case "adjust":
          return api.patch(
            `${path}/payments/${change.billId}`,
            change.request,
            payrollRunDetailSchema,
          );
        case "leave_out":
          return api.post(
            `${path}/payments/${change.billId}/leave-out`,
            { reason: change.reason },
            payrollRunDetailSchema,
          );
        case "one_off":
          return api.post(
            `${path}/one-offs`,
            change.request,
            payrollRunDetailSchema,
          );
      }
    },
    onSuccess: storeRun,
  });
}

/** The signed-in person's own salary payments in this company, newest first. */
export function useMySalaryPayments(
  organizationId: string,
): UseQueryResult<MySalaryPayment[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.mySalaryPayments(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/me/salary-payments`,
        mySalaryPaymentsResponseSchema,
      ),
  });
}
