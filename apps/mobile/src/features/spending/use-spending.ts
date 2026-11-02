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
  CompanySpendingDetail,
  CompanySpendingPage,
  CreatePaidFromAccountRequest,
  OverviewHeading,
  PaidFromAccount,
  RecordCompanySpendingRequest,
  UpdateCompanySpendingRequest,
  UpdatePaidFromAccountRequest,
} from "@expendi-business/shared";
import {
  companySpendingDetailSchema,
  companySpendingPageSchema,
  paidFromAccountSchema,
  paidFromAccountsResponseSchema,
} from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";

function spendingPath(organizationId: string) {
  return `/organizations/${organizationId}/company-spending` as const;
}

function accountsPath(organizationId: string) {
  return `/organizations/${organizationId}/paid-from-accounts` as const;
}

/** Latest date first, a page at a time. Admins only (spec §4). */
export function useCompanySpendingList(
  organizationId: string,
  heading: OverviewHeading | null,
): UseInfiniteQueryResult<InfiniteData<CompanySpendingPage>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.companySpendingList(organizationId, { heading }),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (heading) query.set("heading", heading);
      if (pageParam !== null) query.set("cursor", pageParam);
      const search = query.toString();
      return api.get(
        search === ""
          ? spendingPath(organizationId)
          : `${spendingPath(organizationId)}?${search}`,
        companySpendingPageSchema,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function useCompanySpending(
  organizationId: string,
  spendingId: string,
): UseQueryResult<CompanySpendingDetail> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.companySpendingItem(organizationId, spendingId),
    queryFn: () =>
      api.get(
        `${spendingPath(organizationId)}/${spendingId}`,
        companySpendingDetailSchema,
      ),
  });
}

/** Marking a bill paid outside records spending too, so it refreshes with bills. */
export function useInvalidateCompanySpending(
  organizationId: string,
): () => Promise<void> {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.companySpending(organizationId),
    });
}

export function useRecordCompanySpending(
  organizationId: string,
): UseMutationResult<
  CompanySpendingDetail,
  Error,
  RecordCompanySpendingRequest
> {
  const api = useApi();
  const invalidate = useInvalidateCompanySpending(organizationId);
  return useMutation({
    mutationFn: (spending) =>
      api.post(
        spendingPath(organizationId),
        spending,
        companySpendingDetailSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useUpdateCompanySpending(
  organizationId: string,
  spendingId: string,
): UseMutationResult<
  CompanySpendingDetail,
  Error,
  UpdateCompanySpendingRequest
> {
  const api = useApi();
  const invalidate = useInvalidateCompanySpending(organizationId);
  return useMutation({
    mutationFn: (changes) =>
      api.patch(
        `${spendingPath(organizationId)}/${spendingId}`,
        changes,
        companySpendingDetailSchema,
      ),
    onSuccess: invalidate,
  });
}

/** The accounts in use, or the archived ones. */
export function usePaidFromAccounts(
  organizationId: string,
  { archived = false }: { archived?: boolean } = {},
): UseQueryResult<PaidFromAccount[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.paidFromAccountList(organizationId, archived),
    queryFn: () =>
      api.get(
        archived
          ? `${accountsPath(organizationId)}?archived=true`
          : accountsPath(organizationId),
        paidFromAccountsResponseSchema,
      ),
  });
}

/** An account's name shows on spending, so spending refreshes too. */
function useInvalidateAccounts(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.paidFromAccounts(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySpending(organizationId),
      }),
    ]);
}

export function useCreatePaidFromAccount(
  organizationId: string,
): UseMutationResult<PaidFromAccount, Error, CreatePaidFromAccountRequest> {
  const api = useApi();
  const invalidate = useInvalidateAccounts(organizationId);
  return useMutation({
    mutationFn: (account) =>
      api.post(accountsPath(organizationId), account, paidFromAccountSchema),
    onSuccess: invalidate,
  });
}

export function useUpdatePaidFromAccount(
  organizationId: string,
): UseMutationResult<
  PaidFromAccount,
  Error,
  { accountId: string; changes: UpdatePaidFromAccountRequest }
> {
  const api = useApi();
  const invalidate = useInvalidateAccounts(organizationId);
  return useMutation({
    mutationFn: ({ accountId, changes }) =>
      api.patch(
        `${accountsPath(organizationId)}/${accountId}`,
        changes,
        paidFromAccountSchema,
      ),
    onSuccess: invalidate,
  });
}

export function useArchivePaidFromAccount(
  organizationId: string,
): UseMutationResult<PaidFromAccount, Error, string> {
  const api = useApi();
  const invalidate = useInvalidateAccounts(organizationId);
  return useMutation({
    mutationFn: (accountId) =>
      api.post(
        `${accountsPath(organizationId)}/${accountId}/archive`,
        {},
        paidFromAccountSchema,
      ),
    onSuccess: invalidate,
  });
}
