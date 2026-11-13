"use client";

import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  infiniteQueryOptions,
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
  FundIn,
  FundInRequest,
  FundInStatus,
  PayeeChain,
  PayoutStatus,
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
  fundInSchema,
  fundInsResponseSchema,
  isPaymentInFlight,
  paymentPollInterval,
  walletHistoryResponseSchema,
  walletResponseSchema,
  walletSetupSchema,
  withdrawalAddressesResponseSchema,
  withdrawalAddressSchema,
  withdrawalChallengeSchema,
  withdrawalSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import type { ApprovalOutcome } from "~/lib/approval";
import { useRefreshWhenSettled } from "~/lib/payment-poll";
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
  fundIns: (organizationId: string) =>
    ["wallet", organizationId, "fund-ins"] as const,
  fundIn: (organizationId: string, fundInId: string) =>
    ["wallet", organizationId, "fund-ins", fundInId] as const,
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

const payoutStatuses = (
  history: InfiniteData<WalletHistoryResponse> | undefined,
): PayoutStatus[] =>
  (history?.pages ?? [])
    .flatMap((page) => page.items)
    .flatMap((item) => (item.payout ? [item.payout.status] : []));

/** How many payouts among the history's loaded rows are on their way. */
export function payoutsInFlight(
  history: InfiniteData<WalletHistoryResponse> | undefined,
): number {
  return payoutStatuses(history).filter((status) =>
    isPaymentInFlight({ payouts: [status] }),
  ).length;
}

/**
 * Newest first: deposits, payments, refunds and withdrawals. Asked about
 * again every few seconds while a payout in it is on its way.
 */
export function walletHistoryQuery(api: ApiClient, organizationId: string) {
  return infiniteQueryOptions({
    queryKey: walletKeys.history(organizationId),
    queryFn: ({ pageParam }) =>
      api.get(
        `${walletPath(organizationId)}/history?limit=${String(HISTORY_PAGE_SIZE)}${pageParam ? `&before=${pageParam}` : ""}`,
        walletHistoryResponseSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: (query) =>
      paymentPollInterval({ payouts: payoutStatuses(query.state.data) }),
  });
}

/**
 * The history; when a payout in it settles, the balance and the rest of
 * the wallet are fetched again.
 */
export function useWalletHistory(
  organizationId: string,
): UseInfiniteQueryResult<InfiniteData<WalletHistoryResponse>> {
  const api = useApi();
  const queryClient = useQueryClient();
  const history = useInfiniteQuery(walletHistoryQuery(api, organizationId));
  useRefreshWhenSettled(payoutsInFlight(history.data), () =>
    queryClient.invalidateQueries({
      queryKey: walletKeys.all(organizationId),
    }),
  );
  return history;
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

const fundInsPath = (organizationId: string) =>
  `${walletPath(organizationId)}/fund-ins` as const;

/** A fund-in in one of these has stopped changing. */
const FINAL_FUND_IN_STATUSES: readonly FundInStatus[] = [
  "completed",
  "returned",
  "refunded",
  "failed",
  "expired",
];

export function isFinalFundIn(status: FundInStatus): boolean {
  return FINAL_FUND_IN_STATUSES.includes(status);
}

const FUND_IN_POLL_MS = 5000;

/** How long until a fund-in is asked about again; false once it's final. */
export function fundInPollInterval(fundIn: FundIn | undefined): number | false {
  return fundIn && isFinalFundIn(fundIn.status) ? false : FUND_IN_POLL_MS;
}

/** The company's fund-ins from other chains, newest first. */
export function useFundIns(organizationId: string): UseQueryResult<FundIn[]> {
  const api = useApi();
  return useQuery({
    queryKey: walletKeys.fundIns(organizationId),
    queryFn: () => api.get(fundInsPath(organizationId), fundInsResponseSchema),
  });
}

/**
 * One fund-in, asked about again every few seconds until it's final. When
 * it completes the wallet's balance and history are fetched again.
 */
export function useFundIn(
  organizationId: string,
  fundInId: string,
): UseQueryResult<FundIn> {
  const api = useApi();
  const queryClient = useQueryClient();
  const fundIn = useQuery({
    queryKey: walletKeys.fundIn(organizationId, fundInId),
    queryFn: () =>
      api.get(`${fundInsPath(organizationId)}/${fundInId}`, fundInSchema),
    refetchInterval: (query) => fundInPollInterval(query.state.data),
  });
  const status = fundIn.data?.status;
  useEffect(() => {
    if (status !== "completed") return;
    void queryClient.invalidateQueries({
      queryKey: walletKeys.summary(organizationId),
    });
    void queryClient.invalidateQueries({
      queryKey: walletKeys.history(organizationId),
    });
  }, [status, organizationId, queryClient]);
  return fundIn;
}

/** Asks for a one-time deposit address on another chain. */
export function useStartFundIn(
  organizationId: string,
): UseMutationResult<FundIn, Error, FundInRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      api.post(fundInsPath(organizationId), request, fundInSchema),
    onSuccess: (fundIn) => {
      queryClient.setQueryData(
        walletKeys.fundIn(organizationId, fundIn.id),
        fundIn,
      );
      return queryClient.invalidateQueries({
        queryKey: walletKeys.fundIns(organizationId),
        exact: true,
      });
    },
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

/**
 * Whether the withdrawal the API prepared is the one the admin reviewed, so
 * only that is signed. Addresses are compared as written: a NEAR account or
 * a Solana address has no other case.
 */
export function isReviewedWithdrawal(
  prepared: Pick<Withdrawal, "chain" | "address" | "amountUsdc">,
  reviewed: Pick<Withdrawal, "chain" | "address" | "amountUsdc">,
): boolean {
  return (
    prepared.amountUsdc === reviewed.amountUsdc &&
    prepared.chain === reviewed.chain &&
    prepared.address === reviewed.address
  );
}

export type WithdrawVariables = CreateWithdrawalRequest & {
  /** The allowlisted address the admin reviewed, and its payee chain. */
  readonly chain: PayeeChain;
  readonly address: string;
};

/**
 * Withdraws to an allowlisted address, as the app does
 * (`apps/mobile/src/features/wallet/use-withdraw.ts`): the API prepares the
 * withdrawal and a challenge bound to its payee chain, address and amount,
 * the browser signs it, and the API sends it once. The same `requestId` is always the
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
      request: async ({ chain, address, ...request }) => {
        const challenge = await api.post(
          path,
          request,
          withdrawalChallengeSchema,
        );
        if (
          !isReviewedWithdrawal(challenge.withdrawal, {
            chain,
            address,
            amountUsdc: request.amountUsdc,
          })
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
