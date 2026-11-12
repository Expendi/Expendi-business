"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

import type {
  Customer,
  CustomerInput,
  CustomerUpdate,
  Invoice,
  InvoiceDraftRequest,
  InvoiceMarkPaidInput,
  InvoiceSummary,
  InvoiceVoidInput,
  MatchableDeposit,
} from "@expendi-business/shared";
import {
  customerSchema,
  invoiceSchema,
  invoiceSummarySchema,
  matchableDepositSchema,
} from "@expendi-business/shared";

import type { InvoiceFilter } from "./invoice-keys";
import type { ApiClient } from "~/lib/api";
import { walletPrefix } from "~/features/payment-keys";
import { useApi } from "~/lib/use-api";
import { customerKeys, invoiceKeys } from "./invoice-keys";

/** The invoice and customer routes the app uses: admins act, accountants read. */

const invoicesPath = (organizationId: string) =>
  `/organizations/${organizationId}/invoices` as const;
const customersPath = (organizationId: string) =>
  `/organizations/${organizationId}/customers` as const;

const customersResponseSchema = z.object({
  customers: z.array(customerSchema),
});
const invoicesResponseSchema = z.object({
  invoices: z.array(invoiceSummarySchema),
});
const nextNumberSchema = z.object({ number: z.string() });
const remindedSchema = z.object({ remindedAt: z.iso.datetime() });
const depositsResponseSchema = z.object({
  deposits: z.array(matchableDepositSchema),
});
/** A 204 has no body; the client hands the schema `undefined`. */
const noContentSchema = z.unknown();

/**
 * Every invoice and customer call, one function each, so a test can check
 * which route an action reaches without rendering a hook.
 */
export function invoiceCalls(api: ApiClient, organizationId: string) {
  const invoices = invoicesPath(organizationId);
  const customers = customersPath(organizationId);
  const invoicePost = (path: string, body: unknown) =>
    api.post(`${invoices}/${path}`, body, invoiceSchema);
  return {
    listInvoices: async (status: InvoiceFilter | null) =>
      (
        await api.get(
          status === null ? invoices : `${invoices}?status=${status}`,
          invoicesResponseSchema,
        )
      ).invoices,
    getInvoice: (invoiceId: string) =>
      api.get(`${invoices}/${invoiceId}`, invoiceSchema),
    nextNumber: async () =>
      (await api.get(`${invoices}/next-number`, nextNumberSchema)).number,
    matchableDeposits: async (invoiceId: string) =>
      (
        await api.get(
          `${invoices}/${invoiceId}/matchable-deposits`,
          depositsResponseSchema,
        )
      ).deposits,
    listCustomers: async (includeArchived: boolean) =>
      (
        await api.get(
          `${customers}?includeArchived=${String(includeArchived)}`,
          customersResponseSchema,
        )
      ).customers,
    createCustomer: (customer: CustomerInput) =>
      api.post(customers, customer, customerSchema),
    updateCustomer: (customerId: string, changes: CustomerUpdate) =>
      api.patch(`${customers}/${customerId}`, changes, customerSchema),
    saveInvoice: (invoiceId: string | null, request: InvoiceDraftRequest) =>
      invoiceId === null
        ? api.post(invoices, request, invoiceSchema)
        : api.patch(`${invoices}/${invoiceId}`, request, invoiceSchema),
    sendInvoice: (invoiceId: string) => invoicePost(`${invoiceId}/send`, {}),
    deleteInvoice: async (invoiceId: string) => {
      await api.delete(`${invoices}/${invoiceId}`, noContentSchema);
    },
    remindInvoice: (invoiceId: string) =>
      api.post(`${invoices}/${invoiceId}/remind`, {}, remindedSchema),
    voidInvoice: (invoiceId: string, voiding: InvoiceVoidInput) =>
      invoicePost(`${invoiceId}/void`, voiding),
    markPaid: (invoiceId: string, payment: InvoiceMarkPaidInput) =>
      invoicePost(`${invoiceId}/mark-paid`, payment),
    matchDeposit: (invoiceId: string, walletTransactionId: string) =>
      invoicePost(`${invoiceId}/match`, { walletTransactionId }),
    undoPayment: (invoiceId: string, paymentId: string) =>
      api.delete(
        `${invoices}/${invoiceId}/payments/${paymentId}`,
        invoiceSchema,
      ),
  };
}

export function useInvoices(
  organizationId: string,
  status: InvoiceFilter | null,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<InvoiceSummary[]> {
  const api = useApi();
  return useQuery({
    queryKey: invoiceKeys.list(organizationId, status),
    queryFn: () => invoiceCalls(api, organizationId).listInvoices(status),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useInvoice(
  organizationId: string,
  invoiceId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<Invoice> {
  const api = useApi();
  return useQuery({
    queryKey: invoiceKeys.detail(organizationId, invoiceId),
    queryFn: () => invoiceCalls(api, organizationId).getInvoice(invoiceId),
    enabled,
  });
}

/** The suggested number for a new invoice; fetched again each time the form opens. */
export function useNextInvoiceNumber(
  organizationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<string> {
  const api = useApi();
  return useQuery({
    queryKey: invoiceKeys.nextNumber(organizationId),
    queryFn: () => invoiceCalls(api, organizationId).nextNumber(),
    gcTime: 0,
    enabled,
  });
}

export function useMatchableDeposits(
  organizationId: string,
  invoiceId: string,
): UseQueryResult<MatchableDeposit[]> {
  const api = useApi();
  return useQuery({
    queryKey: invoiceKeys.deposits(organizationId, invoiceId),
    queryFn: () =>
      invoiceCalls(api, organizationId).matchableDeposits(invoiceId),
    gcTime: 0,
  });
}

export function useCustomers(
  organizationId: string,
  includeArchived: boolean,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<Customer[]> {
  const api = useApi();
  return useQuery({
    queryKey: customerKeys.list(organizationId, includeArchived),
    queryFn: () =>
      invoiceCalls(api, organizationId).listCustomers(includeArchived),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * A payment recorded or undone changes the wallet's history too, and a
 * customer's changes show on their draft invoices.
 */
export function useInvalidateInvoices(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        invoiceKeys.all(organizationId),
        customerKeys.all(organizationId),
        walletPrefix(organizationId),
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

export function useCreateCustomer(
  organizationId: string,
): UseMutationResult<Customer, Error, CustomerInput> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (customer) =>
      invoiceCalls(api, organizationId).createCustomer(customer),
    onSuccess: invalidate,
  });
}

export function useUpdateCustomer(
  organizationId: string,
  customerId: string,
): UseMutationResult<Customer, Error, CustomerUpdate> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (changes) =>
      invoiceCalls(api, organizationId).updateCustomer(customerId, changes),
    onSuccess: invalidate,
  });
}

export interface SaveInvoiceRequest {
  /** Null creates the invoice; otherwise the draft is replaced. */
  readonly invoiceId: string | null;
  readonly request: InvoiceDraftRequest;
}

export function useSaveInvoice(
  organizationId: string,
): UseMutationResult<Invoice, Error, SaveInvoiceRequest> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: ({ invoiceId, request }) =>
      invoiceCalls(api, organizationId).saveInvoice(invoiceId, request),
    onSuccess: invalidate,
  });
}

export function useSendInvoice(
  organizationId: string,
): UseMutationResult<Invoice, Error, string> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (invoiceId) =>
      invoiceCalls(api, organizationId).sendInvoice(invoiceId),
    onSuccess: invalidate,
  });
}

export function useDeleteInvoice(
  organizationId: string,
  invoiceId: string,
): UseMutationResult<void, Error, void> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: () =>
      invoiceCalls(api, organizationId).deleteInvoice(invoiceId),
    onSuccess: invalidate,
  });
}

export function useRemindInvoice(
  organizationId: string,
  invoiceId: string,
): UseMutationResult<{ remindedAt: string }, Error, void> {
  const api = useApi();
  return useMutation({
    mutationFn: () =>
      invoiceCalls(api, organizationId).remindInvoice(invoiceId),
  });
}

export function useVoidInvoice(
  organizationId: string,
  invoiceId: string,
): UseMutationResult<Invoice, Error, InvoiceVoidInput> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (voiding) =>
      invoiceCalls(api, organizationId).voidInvoice(invoiceId, voiding),
    onSuccess: invalidate,
  });
}

export function useMarkInvoicePaid(
  organizationId: string,
  invoiceId: string,
): UseMutationResult<Invoice, Error, InvoiceMarkPaidInput> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (payment) =>
      invoiceCalls(api, organizationId).markPaid(invoiceId, payment),
    onSuccess: invalidate,
  });
}

export function useMatchDeposit(
  organizationId: string,
  invoiceId: string,
): UseMutationResult<Invoice, Error, string> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (walletTransactionId) =>
      invoiceCalls(api, organizationId).matchDeposit(
        invoiceId,
        walletTransactionId,
      ),
    onSuccess: invalidate,
  });
}

export function useUndoInvoicePayment(
  organizationId: string,
  invoiceId: string,
): UseMutationResult<Invoice, Error, string> {
  const api = useApi();
  const invalidate = useInvalidateInvoices(organizationId);
  return useMutation({
    mutationFn: (paymentId) =>
      invoiceCalls(api, organizationId).undoPayment(invoiceId, paymentId),
    onSuccess: invalidate,
  });
}
