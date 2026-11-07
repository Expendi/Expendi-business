"use client";

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
import { useEffect } from "react";

import type {
  AllowlistChange,
  ApprovalChallenge,
  CreateWithdrawalRequest,
  WalletHistoryItem,
  WalletHistoryResponse,
  WalletResponse,
  WalletSetup,
  Withdrawal,
  WithdrawalAddress,
  WithdrawalChallenge,
} from "@expendi-business/shared";
import {
  approvalChallengeSchema,
  walletHistoryResponseSchema,
  walletResponseSchema,
  walletSetupSchema,
  withdrawalAddressesResponseSchema,
  withdrawalAddressSchema,
  withdrawalChallengeSchema,
  withdrawalSchema,
} from "@expendi-business/shared";

import type { ApprovalOutcome } from "~/lib/approval";
import { useApi } from "~/lib/use-api";
import { usePasskeyApproval } from "~/lib/use-approval";
import { nairobiDay } from "./wallet-display";

/**
 * The wallet routes the app uses (T21, T33): balance, history, the
 * allowlist and withdrawals, the last two confirmed with the admin's
 * passkey (spec §6.9, §7).
 */

const HISTORY_PAGE_SIZE = 25;

export const walletKeys = {
  /** Everything about a company's wallet, to refresh after money moves. */
  all: (organizationId: string) => ["wallet", organizationId] as const,
  summary: (organizationId: string) =>
    ["wallet", organizationId, "summary"] as const,
  history: (organizationId: string) =>
    ["wallet", organizationId, "history"] as const,
  /** The ledger back to the start of the balance chart, in big pages. */
  balanceHistory: (organizationId: string) =>
    ["wallet", organizationId, "history", "balance"] as const,
  addresses: (organizationId: string) =>
    ["wallet", organizationId, "addresses"] as const,
};

const walletPath = (organizationId: string) =>
  `/organizations/${organizationId}/wallet` as const;

const addressesPath = (organizationId: string) =>
  `/organizations/${organizationId}/withdrawal-addresses` as const;

export function useCompanyWallet(
  organizationId: string,
): UseQueryResult<WalletResponse> {
  const api = useApi();
  return useQuery({
    queryKey: walletKeys.summary(organizationId),
    queryFn: () => api.get(walletPath(organizationId), walletResponseSchema),
  });
}

/** Resumes a wallet whose setup stopped at sign-up; safe to repeat. */
export function useFinishWalletSetup(
  organizationId: string,
): UseMutationResult<WalletSetup, Error, void> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(walletPath(organizationId), undefined, walletSetupSchema),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: walletKeys.all(organizationId),
      }),
  });
}

/** Newest first: deposits, payments, refunds and withdrawals. */
export function useWalletHistory(
  organizationId: string,
): UseInfiniteQueryResult<InfiniteData<WalletHistoryResponse>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: walletKeys.history(organizationId),
    queryFn: ({ pageParam }) =>
      api.get(
        `${walletPath(organizationId)}/history?limit=${String(HISTORY_PAGE_SIZE)}${pageParam ? `&before=${pageParam}` : ""}`,
        walletHistoryResponseSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/** The API's largest history page. */
const BALANCE_PAGE_SIZE = 100;

/** Enough pages for a busy month; the chart stops there if there are more. */
const BALANCE_MAX_PAGES = 10;

/**
 * The ledger back to `since` (a Nairobi day), for the balance chart and the
 * month's money in and out. Loads further pages by itself until it gets
 * there; `complete` is false while it's still on its way.
 */
export function useBalanceHistory(
  organizationId: string,
  since: string,
): {
  readonly items: readonly WalletHistoryItem[] | null;
  readonly complete: boolean;
} {
  const api = useApi();
  const history = useInfiniteQuery({
    queryKey: walletKeys.balanceHistory(organizationId),
    queryFn: ({ pageParam }) =>
      api.get(
        `${walletPath(organizationId)}/history?limit=${String(BALANCE_PAGE_SIZE)}${pageParam ? `&before=${pageParam}` : ""}`,
        walletHistoryResponseSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const pages = history.data?.pages;
  const items = pages?.flatMap((page) => page.items) ?? null;
  const oldest = items?.at(-1)?.createdAt;
  const reached = oldest === undefined || nairobiDay(oldest) < since;
  const needsMore =
    pages !== undefined &&
    !reached &&
    history.hasNextPage &&
    pages.length < BALANCE_MAX_PAGES;
  const { fetchNextPage, isFetchingNextPage } = history;
  useEffect(() => {
    if (needsMore && !isFetchingNextPage) void fetchNextPage();
  }, [needsMore, isFetchingNextPage, fetchNextPage]);
  return { items, complete: items !== null && !needsMore };
}

/** The company's allowlist, oldest first. */
export function useWithdrawalAddresses(
  organizationId: string,
): UseQueryResult<WithdrawalAddress[]> {
  const api = useApi();
  return useQuery({
    queryKey: walletKeys.addresses(organizationId),
    queryFn: () =>
      api.get(addressesPath(organizationId), withdrawalAddressesResponseSchema),
  });
}

/**
 * Adds or removes an address with the admin's passkey. The API binds the
 * challenge to the exact change, so the change goes back with the signature.
 */
export function useChangeAllowlist(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<WithdrawalAddress>,
  Error,
  AllowlistChange
> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = addressesPath(organizationId);
  return usePasskeyApproval<
    AllowlistChange,
    ApprovalChallenge & { readonly change: AllowlistChange },
    WithdrawalAddress
  >({
    request: async (change) => ({
      ...(await api.post(`${path}/changes`, change, approvalChallengeSchema)),
      change,
    }),
    confirm: (challenge, response) =>
      api.post(
        `${path}/changes/${challenge.challengeId}/confirm`,
        { change: challenge.change, response },
        withdrawalAddressSchema,
      ),
    onApproved: () =>
      queryClient.invalidateQueries({
        queryKey: walletKeys.addresses(organizationId),
      }),
  });
}

export class WithdrawalMismatchError extends Error {
  override readonly name = "WithdrawalMismatchError";

  constructor() {
    super(
      "The withdrawal Expendi prepared doesn't match what you entered. Nothing was sent. Check the details and try again.",
    );
  }
}

export type WithdrawVariables = CreateWithdrawalRequest & {
  /** The allowlisted address the admin reviewed. */
  readonly address: string;
};

/**
 * Withdraws to an allowlisted address, as the app does
 * (`apps/mobile/src/features/wallet/use-withdraw.ts`): the API prepares the
 * withdrawal and a challenge bound to its address and amount, the browser
 * signs it, and the API sends it once. The same `requestId` is always the
 * same withdrawal.
 */
export function useWithdraw(
  organizationId: string,
): UseMutationResult<ApprovalOutcome<Withdrawal>, Error, WithdrawVariables> {
  const api = useApi();
  const queryClient = useQueryClient();
  const path = `/organizations/${organizationId}/withdrawals` as const;
  return usePasskeyApproval<WithdrawVariables, WithdrawalChallenge, Withdrawal>(
    {
      request: async ({ address, ...request }) => {
        const challenge = await api.post(
          path,
          request,
          withdrawalChallengeSchema,
        );
        // Sign only what the admin reviewed.
        if (
          challenge.withdrawal.amountUsdc !== request.amountUsdc ||
          challenge.withdrawal.address !== address.toLowerCase()
        ) {
          throw new WithdrawalMismatchError();
        }
        return challenge;
      },
      confirm: (challenge, response) =>
        api.post(
          `${path}/${challenge.challengeId}/confirm`,
          { response },
          withdrawalSchema,
        ),
      onApproved: () =>
        queryClient.invalidateQueries({
          queryKey: walletKeys.all(organizationId),
        }),
    },
  );
}
