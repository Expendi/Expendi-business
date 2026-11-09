"use client";

import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type {
  CardActionRequest,
  CardActionResult,
  CardConfirmation,
  CardList,
  CardLoadList,
  CardProgram,
  CardPurchase,
  CardPurchaseList,
  ExpendiCard,
  LowerCardLimitRequest,
  TurnOnCardsFields,
  WaiveCardReceiptRequest,
} from "@expendi-business/shared";
import {
  cardActionResultSchema,
  cardConfirmationSchema,
  cardListSchema,
  cardLoadListSchema,
  cardProgramSchema,
  cardPurchaseListSchema,
  cardPurchaseSchema,
  expendiCardSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import type { ApprovalOutcome, PasskeyApprovalSteps } from "~/lib/approval";
import type { CardPurchaseFilters } from "~/lib/query-keys";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/lib/use-api";
import { usePasskeyApproval } from "~/lib/use-approval";

/**
 * The Expendi card routes (spec §6.25) the dashboard uses. Admins act and
 * accountants only read; the API keeps every rule itself. Issuing, raising a
 * limit, unfreezing and Card loads are confirmed with the admin's passkey.
 */

const PURCHASE_PAGE_SIZE = 30;

const cardsPath = (organizationId: string) =>
  `/organizations/${organizationId}/cards` as const;

export function useCardProgram(
  organizationId: string,
): UseQueryResult<CardProgram> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.cardProgram(organizationId),
    queryFn: () =>
      api.get(`${cardsPath(organizationId)}/program`, cardProgramSchema),
  });
}

export function useCards(organizationId: string): UseQueryResult<CardList> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.cardList(organizationId),
    queryFn: () => api.get(cardsPath(organizationId), cardListSchema),
  });
}

export function useCardLoads(
  organizationId: string,
): UseQueryResult<CardLoadList> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.cardLoads(organizationId),
    queryFn: () =>
      api.get(`${cardsPath(organizationId)}/loads`, cardLoadListSchema),
  });
}

/** The query string for `GET …/cards/purchases`, leaving out filters not set. */
export function purchasesQuery(
  filters: CardPurchaseFilters,
  cursor: string | null,
): string {
  const params = new URLSearchParams({
    limit: String(PURCHASE_PAGE_SIZE),
  });
  if (filters.cardId) params.set("cardId", filters.cardId);
  if (filters.status) params.set("status", filters.status);
  if (filters.needsReceipt) params.set("needsReceipt", filters.needsReceipt);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** Newest first, a page at a time. */
export function useCardPurchases(
  organizationId: string,
  filters: CardPurchaseFilters,
): UseInfiniteQueryResult<InfiniteData<CardPurchaseList>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.cardPurchases(organizationId, filters),
    queryFn: ({ pageParam }) =>
      api.get(
        `${cardsPath(organizationId)}/purchases?${purchasesQuery(filters, pageParam)}`,
        cardPurchaseListSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
  });
}

/** "Turn on cards": once per company. */
export function useTurnOnCards(
  organizationId: string,
): UseMutationResult<CardProgram, Error, TurnOnCardsFields> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fields) =>
      api.post(
        `${cardsPath(organizationId)}/program`,
        fields,
        cardProgramSchema,
      ),
    onSuccess: async (program) => {
      queryClient.setQueryData(queryKeys.cardProgram(organizationId), program);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.cards(organizationId),
      });
    },
  });
}

export type BoundCardConfirmation = CardConfirmation & {
  readonly action: CardActionRequest;
};

/**
 * The confirmation is bound to the action, so the very object that asked
 * for the challenge goes back with the signature.
 */
export function cardActionSteps(
  api: ApiClient,
  organizationId: string,
): PasskeyApprovalSteps<
  CardActionRequest,
  BoundCardConfirmation,
  CardActionResult
> {
  const path = `${cardsPath(organizationId)}/confirmations` as const;
  return {
    request: async (action) => ({
      ...(await api.post(path, action, cardConfirmationSchema)),
      action,
    }),
    confirm: (challenge, response) =>
      api.post(
        `${path}/${challenge.challengeId}`,
        { action: challenge.action, response },
        cardActionResultSchema,
      ),
  };
}

/** Issue, raise a limit, unfreeze, or a Card load: each with the admin's passkey. */
export function useCardAction(
  organizationId: string,
): UseMutationResult<
  ApprovalOutcome<CardActionResult>,
  Error,
  CardActionRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return usePasskeyApproval({
    ...cardActionSteps(api, organizationId),
    onApproved: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.cards(organizationId),
      }),
  });
}

function useCardWrite<TVariables>(
  organizationId: string,
  write: (api: ApiClient, variables: TVariables) => Promise<ExpendiCard>,
): UseMutationResult<ExpendiCard, Error, TVariables> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) => write(api, variables),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.cards(organizationId),
      }),
  });
}

/** Needs no passkey: it can only make a card safer. */
export function useFreezeCard(
  organizationId: string,
): UseMutationResult<ExpendiCard, Error, string> {
  return useCardWrite(organizationId, (api, cardId: string) =>
    api.post(
      `${cardsPath(organizationId)}/${cardId}/freeze`,
      undefined,
      expendiCardSchema,
    ),
  );
}

/** Needs no passkey, and can't be undone. */
export function useCloseCard(
  organizationId: string,
): UseMutationResult<ExpendiCard, Error, string> {
  return useCardWrite(organizationId, (api, cardId: string) =>
    api.post(
      `${cardsPath(organizationId)}/${cardId}/close`,
      undefined,
      expendiCardSchema,
    ),
  );
}

export interface LowerLimitVariables extends LowerCardLimitRequest {
  readonly cardId: string;
}

/** Needs no passkey, so it can only go down. */
export function useLowerCardLimit(
  organizationId: string,
): UseMutationResult<ExpendiCard, Error, LowerLimitVariables> {
  return useCardWrite(
    organizationId,
    (api, { cardId, monthlyLimitUsd }: LowerLimitVariables) =>
      api.post(
        `${cardsPath(organizationId)}/${cardId}/lower-limit`,
        { monthlyLimitUsd },
        expendiCardSchema,
      ),
  );
}

export interface WaiveReceiptVariables extends WaiveCardReceiptRequest {
  readonly purchaseId: string;
}

/** An admin says why a Card expense has no receipt, so it can reach the books. */
export function useWaiveCardReceipt(
  organizationId: string,
): UseMutationResult<CardPurchase, Error, WaiveReceiptVariables> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ purchaseId, ...request }) =>
      api.post(
        `${cardsPath(organizationId)}/purchases/${purchaseId}/no-receipt`,
        request,
        cardPurchaseSchema,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.cards(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.expenses(organizationId),
        }),
      ]),
  });
}
