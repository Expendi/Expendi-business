"use client";

import type {
  InfiniteData,
  QueryClient,
  QueryKey,
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
  AttachCardReceiptRequest,
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
  ReviewCardPurchaseRequest,
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
import { billKeys, recurringKeys } from "~/features/payment-keys";
import { ApiError } from "~/lib/api";
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

/** The cards that can pay recurring payments; fetched only while `enabled`. */
export function useCompanyHeldCards(
  organizationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<CardList> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.companyHeldCards(organizationId),
    queryFn: () =>
      api.get(`${cardsPath(organizationId)}?companyHeld=true`, cardListSchema),
    enabled,
  });
}

/** One purchase, for a link to one that isn't on the list's loaded pages. */
export function useCardPurchase(
  organizationId: string,
  purchaseId: string,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<CardPurchase> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.cardPurchase(organizationId, purchaseId),
    queryFn: () =>
      api.get(
        `${cardsPath(organizationId)}/purchases/${purchaseId}`,
        cardPurchaseSchema,
      ),
    enabled,
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
  if (filters.needsReview) params.set("needsReview", filters.needsReview);
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

/**
 * A card's state and its recurring payments go together: a frozen or
 * closed card declines its payments' bills, and a new one can be picked to
 * pay them, so bills and recurring payments refresh with the cards.
 */
export function refreshAfterCardChange(
  queryClient: QueryClient,
  organizationId: string,
): Promise<unknown> {
  return Promise.all(
    [
      queryKeys.cards(organizationId),
      recurringKeys.all(organizationId),
      billKeys.all(organizationId),
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
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
    onApproved: () => refreshAfterCardChange(queryClient, organizationId),
  });
}

/** While it's pending, the recurring payment form around it can't be saved or left. */
export const issueCompanyCardKey = (organizationId: string) =>
  [...queryKeys.cards(organizationId), "issue-company-card"] as const;

/** A company-held card issued from the recurring payment form, with the admin's passkey. */
export function useIssueCompanyCard(
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
    mutationKey: issueCompanyCardKey(organizationId),
    onApproved: () => refreshAfterCardChange(queryClient, organizationId),
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
    onSuccess: () => refreshAfterCardChange(queryClient, organizationId),
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

/** Where the browser opens a card's number, until `expiresAt`. */
export interface RevealSession {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * Passkey, then the address of the page that shows the number. The session
 * goes straight to `onSession` and the mutation resolves to nothing, so it
 * never sits in the mutation cache.
 */
export function cardRevealSteps(
  api: ApiClient,
  organizationId: string,
  onSession: (session: RevealSession) => void,
): PasskeyApprovalSteps<string, BoundCardConfirmation, void> {
  const steps = cardActionSteps(api, organizationId);
  return {
    request: (cardId) => steps.request({ type: "reveal_card", cardId }),
    confirm: async (challenge, assertion) => {
      const result = await steps.confirm(challenge, assertion);
      if (result.type !== "reveal_card") {
        throw new ApiError(
          200,
          "InvalidResponse",
          "The server sent a response this version of Expendi Business can't read.",
        );
      }
      onSession({ url: result.revealUrl, expiresAt: result.expiresAt });
    },
  };
}

/** Any admin can see a company-held card's number with a fresh passkey. */
export function useCardReveal(
  organizationId: string,
  onSession: (session: RevealSession) => void,
): UseMutationResult<ApprovalOutcome<void>, Error, string> {
  const api = useApi();
  return usePasskeyApproval(cardRevealSteps(api, organizationId, onSession));
}

/** `POST …/cards/purchases/:purchaseId/review`: an admin's answer about a new merchant. */
export function reviewCardPurchase(
  api: ApiClient,
  organizationId: string,
  purchaseId: string,
  review: ReviewCardPurchaseRequest,
): Promise<CardPurchase> {
  return api.post(
    `${cardsPath(organizationId)}/purchases/${purchaseId}/review`,
    review,
    cardPurchaseSchema,
  );
}

export interface ReviewPurchaseVariables {
  readonly purchaseId: string;
  readonly review: ReviewCardPurchaseRequest;
}

/**
 * The saved purchase goes into its own query before the lists refetch, so
 * its open sheet stays when a filter ("Needs an answer", "Needs a receipt")
 * now leaves it out of the list it was opened from.
 */
function keepSavedPurchase(
  queryClient: QueryClient,
  organizationId: string,
  purchase: CardPurchase,
  refresh: readonly QueryKey[],
): Promise<unknown> {
  queryClient.setQueryData(
    queryKeys.cardPurchase(organizationId, purchase.id),
    purchase,
  );
  return Promise.all(
    [queryKeys.cards(organizationId), ...refresh].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

/** Linking a purchase can pay a bill and record a merchant, so bills and recurring payments refresh too. */
export function afterPurchaseAnswered(
  queryClient: QueryClient,
  organizationId: string,
  purchase: CardPurchase,
): Promise<unknown> {
  return keepSavedPurchase(queryClient, organizationId, purchase, [
    queryKeys.expenses(organizationId),
    billKeys.all(organizationId),
    recurringKeys.all(organizationId),
  ]);
}

/** A receipt or its waiver completes the Card expense. */
export function afterPurchaseReceipt(
  queryClient: QueryClient,
  organizationId: string,
  purchase: CardPurchase,
): Promise<unknown> {
  return keepSavedPurchase(queryClient, organizationId, purchase, [
    queryKeys.expenses(organizationId),
  ]);
}

export function useReviewCardPurchase(
  organizationId: string,
): UseMutationResult<CardPurchase, Error, ReviewPurchaseVariables> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ purchaseId, review }) =>
      reviewCardPurchase(api, organizationId, purchaseId, review),
    onSuccess: (purchase) =>
      afterPurchaseAnswered(queryClient, organizationId, purchase),
  });
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
    onSuccess: (purchase) =>
      afterPurchaseReceipt(queryClient, organizationId, purchase),
  });
}

export interface AttachReceiptVariables extends AttachCardReceiptRequest {
  readonly purchaseId: string;
}

/** `POST …/cards/purchases/:purchaseId/receipts`: an admin adds a company-held card purchase's receipt. */
export function attachCardReceipt(
  api: ApiClient,
  organizationId: string,
  { purchaseId, ...request }: AttachReceiptVariables,
): Promise<CardPurchase> {
  return api.post(
    `${cardsPath(organizationId)}/purchases/${purchaseId}/receipts`,
    request,
    cardPurchaseSchema,
  );
}

export function useAttachCardReceipt(
  organizationId: string,
): UseMutationResult<CardPurchase, Error, AttachReceiptVariables> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables) =>
      attachCardReceipt(api, organizationId, variables),
    onSuccess: (purchase) =>
      afterPurchaseReceipt(queryClient, organizationId, purchase),
  });
}
