"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  Bill,
  BillDetail,
  BillPayment,
  BillPaymentResult,
  CancelBillRequest,
  CreateBillRequest,
  MarkBillPaidOutsideRequest,
  PaidFromAccount,
  UpdateBillRequest,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  billsResponseSchema,
  paidFromAccountsResponseSchema,
  walletResponseSchema,
} from "@expendi-business/shared";

import type { BillPaymentRequest } from "./bill-payment";
import type { BillListView } from "~/features/payment-keys";
import type { ApiClient } from "~/lib/api";
import type { ApprovalOutcome } from "~/lib/approval";
import {
  billKeys,
  payrollKeys,
  recurringKeys,
  walletPrefix,
} from "~/features/payment-keys";
import { isChallengeFresh } from "~/lib/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/lib/use-api";
import { usePasskeyApproval } from "~/lib/use-approval";
import {
  HISTORY_BILL_STATUSES,
  HISTORY_DAYS,
  nairobiIsoDate,
  OPEN_BILL_STATUSES,
  shiftIsoDate,
} from "./bill-groups";
import {
  confirmBillPayment,
  CostChangedError,
  prepareBillPayment,
  sameBillCost,
} from "./bill-payment";

/** The bill routes the app uses (T35, T37): admins act, accountants read. */

const billsPath = (organizationId: string) =>
  `/organizations/${organizationId}/bills` as const;

/** Open bills by due date; history is paid and cancelled bills due in the last six months. */
export function listBills(
  api: ApiClient,
  organizationId: string,
  view: BillListView,
  today: string,
): Promise<Bill[]> {
  const query =
    view === "open"
      ? `status=${OPEN_BILL_STATUSES.join(",")}`
      : `status=${HISTORY_BILL_STATUSES.join(",")}&dueFrom=${shiftIsoDate(today, -HISTORY_DAYS)}`;
  return api.get(`${billsPath(organizationId)}?${query}`, billsResponseSchema);
}

export function createBill(
  api: ApiClient,
  organizationId: string,
  bill: CreateBillRequest,
): Promise<BillDetail> {
  return api.post(billsPath(organizationId), bill, billDetailSchema);
}

export function attachBillFiles(
  api: ApiClient,
  organizationId: string,
  billId: string,
  receiptFileIds: readonly string[],
): Promise<BillDetail> {
  return api.post(
    `${billsPath(organizationId)}/${billId}/attachments`,
    { receiptFileIds },
    billDetailSchema,
  );
}

export function useBills(
  organizationId: string,
  view: BillListView,
): UseQueryResult<Bill[]> {
  const api = useApi();
  return useQuery({
    queryKey: billKeys.list(organizationId, view),
    queryFn: () =>
      listBills(api, organizationId, view, nairobiIsoDate(new Date())),
  });
}

export function useBill(
  organizationId: string,
  billId: string,
): UseQueryResult<BillDetail> {
  const api = useApi();
  return useQuery({
    queryKey: billKeys.detail(organizationId, billId),
    queryFn: () =>
      api.get(`${billsPath(organizationId)}/${billId}`, billDetailSchema),
  });
}

/**
 * Paycrest's KES per USDC now, from the wallet, to show a USD bill's KES
 * equivalent before it's paid; null while Paycrest is unavailable.
 */
export function useKesRate(
  organizationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): string | null {
  const api = useApi();
  const wallet = useQuery({
    queryKey: billKeys.kesRate(organizationId),
    queryFn: () =>
      api.get(`/organizations/${organizationId}/wallet`, walletResponseSchema),
    enabled,
  });
  return wallet.data?.status === "active"
    ? (wallet.data.kesEquivalent?.rate ?? null)
    : null;
}

/** The accounts a bill paid outside Expendi can be paid from (spec §6.23). */
export function usePaidFromAccounts(
  organizationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<PaidFromAccount[]> {
  const api = useApi();
  return useQuery({
    queryKey: billKeys.paidFromAccounts(organizationId),
    queryFn: () =>
      api.get(
        `/organizations/${organizationId}/paid-from-accounts`,
        paidFromAccountsResponseSchema,
      ),
    enabled,
  });
}

/**
 * Settling a recurring bill creates its next one, and a bill paid outside
 * is recorded as company spending, so those refresh too.
 */
export function useInvalidateBills(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        billKeys.all(organizationId),
        recurringKeys.all(organizationId),
        payrollKeys.all(organizationId),
        walletPrefix(organizationId),
        queryKeys.expenses(organizationId),
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

export function useCreateBill(
  organizationId: string,
): UseMutationResult<BillDetail, Error, CreateBillRequest> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (bill) => createBill(api, organizationId, bill),
    onSuccess: invalidate,
  });
}

export function useUpdateBill(
  organizationId: string,
  billId: string,
): UseMutationResult<BillDetail, Error, UpdateBillRequest> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (changes) =>
      api.patch(
        `${billsPath(organizationId)}/${billId}`,
        changes,
        billDetailSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useAttachBillFiles(
  organizationId: string,
  billId: string,
): UseMutationResult<BillDetail, Error, string[]> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (receiptFileIds) =>
      attachBillFiles(api, organizationId, billId, receiptFileIds),
    onSuccess: invalidate,
  });
}

export function useMarkBillPaidOutside(
  organizationId: string,
  billId: string,
): UseMutationResult<BillDetail, Error, MarkBillPaidOutsideRequest> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (payment) =>
      api.post(
        `${billsPath(organizationId)}/${billId}/mark-paid-outside`,
        payment,
        billDetailSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useCancelBill(
  organizationId: string,
  billId: string,
): UseMutationResult<BillDetail, Error, CancelBillRequest> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (cancellation) =>
      api.post(
        `${billsPath(organizationId)}/${billId}/cancel`,
        cancellation,
        billDetailSchema,
      ),
    onSuccess: invalidate,
  });
}

/** A prepared payment and when it was prepared, to know if its challenge is still good. */
export interface PreparedBillPayment {
  readonly request: BillPaymentRequest;
  readonly payment: BillPayment;
  readonly preparedAt: number;
}

export function usePrepareBillPayment(
  organizationId: string,
): UseMutationResult<PreparedBillPayment, Error, BillPaymentRequest> {
  const api = useApi();
  return useMutation({
    mutationFn: async (request) => ({
      request,
      payment: await prepareBillPayment(api, organizationId, request),
      preparedAt: Date.now(),
    }),
  });
}

/**
 * Signs the prepared challenge, or a fresh one for exactly the same cost,
 * and sends it back once.
 */
export function usePayBills(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<BillPaymentResult>,
  Error,
  PreparedBillPayment
> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return usePasskeyApproval<
    PreparedBillPayment,
    BillPayment,
    BillPaymentResult
  >({
    request: async ({ request, payment, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return payment;
      const fresh = await prepareBillPayment(api, organizationId, request);
      if (!sameBillCost(payment, fresh)) throw new CostChangedError(fresh);
      return fresh;
    },
    confirm: (challenge, response) =>
      confirmBillPayment(api, organizationId, challenge.challengeId, response),
    onApproved: invalidate,
  });
}
