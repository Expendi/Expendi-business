import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  Bill,
  BillDetail,
  CancelBillRequest,
  CreateBillRequest,
  MarkBillPaidOutsideRequest,
  UpdateBillRequest,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  billsResponseSchema,
  paymentPollInterval,
} from "@expendi-business/shared";

import { billListStatuses, billStatuses } from "~/lib/payment-poll";
import { queryKeys } from "~/lib/query-keys";
import { useRefreshWhenPaymentsSettle } from "~/lib/use-payments-settled";
import { useApi } from "~/providers/api-provider";
import {
  HISTORY_BILL_STATUSES,
  HISTORY_DAYS,
  OPEN_BILL_STATUSES,
  shiftIsoDate,
} from "./bill-groups";

function billsPath(organizationId: string) {
  return `/organizations/${organizationId}/bills` as const;
}

/**
 * Unpaid and in-flight bills, by due date, asked about again while one is
 * being paid. Admins only (spec §4).
 */
export function useOpenBills(organizationId: string): UseQueryResult<Bill[]> {
  const api = useApi();
  const bills = useQuery({
    queryKey: queryKeys.billList(organizationId, "open"),
    queryFn: () =>
      api.get(
        `${billsPath(organizationId)}?status=${OPEN_BILL_STATUSES.join(",")}`,
        billsResponseSchema,
      ),
    refetchInterval: (query) =>
      paymentPollInterval(billListStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    billListStatuses(bills.data),
    "bills",
    organizationId,
  );
  return bills;
}

/** Paid and cancelled bills due in the last six months. */
export function useBillHistory(
  organizationId: string,
  today: string,
): UseQueryResult<Bill[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.billList(organizationId, "history"),
    queryFn: () =>
      api.get(
        `${billsPath(organizationId)}?status=${HISTORY_BILL_STATUSES.join(",")}&dueFrom=${shiftIsoDate(today, -HISTORY_DAYS)}`,
        billsResponseSchema,
      ),
  });
}

export function useBill(
  organizationId: string,
  billId: string,
): UseQueryResult<BillDetail> {
  const api = useApi();
  const bill = useQuery({
    queryKey: queryKeys.bill(organizationId, billId),
    queryFn: () =>
      api.get(`${billsPath(organizationId)}/${billId}`, billDetailSchema),
    refetchInterval: (query) =>
      paymentPollInterval(billStatuses(query.state.data)),
  });
  useRefreshWhenPaymentsSettle(
    billStatuses(bill.data),
    "bills",
    organizationId,
  );
  return bill;
}

/** Settling a recurring bill creates its next one, so recurring payments refresh too. */
function useInvalidateBills(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.bills(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.recurringItems(organizationId),
      }),
    ]);
}

export function useCreateBill(
  organizationId: string,
): UseMutationResult<BillDetail, Error, CreateBillRequest> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (bill) =>
      api.post(billsPath(organizationId), bill, billDetailSchema),
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

export function useAttachBillInvoices(
  organizationId: string,
  billId: string,
): UseMutationResult<BillDetail, Error, string[]> {
  const api = useApi();
  const invalidate = useInvalidateBills(organizationId);
  return useMutation({
    mutationFn: (receiptFileIds) =>
      api.post(
        `${billsPath(organizationId)}/${billId}/attachments`,
        { receiptFileIds },
        billDetailSchema,
      ),
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
