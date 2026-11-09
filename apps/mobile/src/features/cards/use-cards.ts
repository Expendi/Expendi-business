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
  AttachCardReceiptRequest,
  CardConfirmation,
  CardList,
  CardPurchase,
  CardPurchaseList,
  ExpendiCard,
} from "@expendi-business/shared";

import type { RevealSession } from "./card-api";
import type { ApprovalOutcome } from "~/features/approval";
import { usePasskeyApproval } from "~/features/approval";
import { queryKeys } from "~/lib/query-keys";
import { useApi } from "~/providers/api-provider";
import {
  attachCardReceiptMutation,
  confirmCardReveal,
  findLoadedPurchase,
  findMyCardPurchase,
  freezeCard,
  listMyCardPurchases,
  listMyCards,
  requestCardReveal,
} from "./card-api";

const RECEIPTS_TO_ADD_PAGE_SIZE = 5;

function useMyCardsQuery<TData>(
  organizationId: string,
  select: (list: CardList) => TData,
): UseQueryResult<TData> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.myCards(organizationId),
    queryFn: () => listMyCards(api, organizationId),
    select,
  });
}

export function useMyCards(
  organizationId: string,
): UseQueryResult<ExpendiCard[]> {
  return useMyCardsQuery(organizationId, (list) => list.cards);
}

/** Undefined data means the card isn't one of the caller's. */
export function useMyCard(
  organizationId: string,
  cardId: string,
): UseQueryResult<ExpendiCard | undefined> {
  return useMyCardsQuery(organizationId, (list) =>
    list.cards.find(({ id }) => id === cardId),
  );
}

/** Newest first. */
export function useCardPurchases(
  organizationId: string,
  cardId: string,
): UseInfiniteQueryResult<InfiniteData<CardPurchaseList>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.cardPurchaseList(organizationId, {
      cardId,
      needsReceipt: false,
    }),
    queryFn: ({ pageParam }) =>
      listMyCardPurchases(api, organizationId, { cardId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export function useReceiptsToAdd(
  organizationId: string,
): UseInfiniteQueryResult<InfiniteData<CardPurchaseList>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.cardPurchaseList(organizationId, {
      cardId: null,
      needsReceipt: true,
    }),
    queryFn: ({ pageParam }) =>
      listMyCardPurchases(api, organizationId, {
        needsReceipt: true,
        limit: RECEIPTS_TO_ADD_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/** Null data means it isn't one of the caller's, or is too old to find. */
export function useCardPurchase(
  organizationId: string,
  purchaseId: string,
): UseQueryResult<CardPurchase | null> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.cardPurchase(organizationId, purchaseId),
    queryFn: () => findMyCardPurchase(api, organizationId, purchaseId),
    initialData: () =>
      findLoadedPurchase(
        queryClient
          .getQueriesData<InfiniteData<CardPurchaseList>>({
            queryKey: queryKeys.cardPurchaseLists(organizationId),
          })
          .map(([, list]) => list),
        purchaseId,
      ),
  });
}

function useInvalidateCards(organizationId: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.cards(organizationId),
    });
}

export function useFreezeCard(
  organizationId: string,
  cardId: string,
): UseMutationResult<void, Error, void> {
  const api = useApi();
  const invalidate = useInvalidateCards(organizationId);
  return useMutation({
    mutationFn: () => freezeCard(api, organizationId, cardId),
    onSuccess: invalidate,
  });
}

export function useAttachCardReceipt(
  organizationId: string,
  purchaseId: string,
): UseMutationResult<void, Error, AttachCardReceiptRequest> {
  const api = useApi();
  const invalidate = useInvalidateCards(organizationId);
  return useMutation(
    attachCardReceiptMutation(api, organizationId, purchaseId, invalidate),
  );
}

/**
 * Passkey, then Lithic's reveal page. The session goes straight to `onSession`
 * and the mutation resolves to nothing, so it never sits in the mutation cache.
 */
export function useCardReveal(
  organizationId: string,
  cardId: string,
  onSession: (session: RevealSession) => void,
): UseMutationResult<ApprovalOutcome<void>, Error, void> {
  const api = useApi();
  return usePasskeyApproval<void, CardConfirmation, void>({
    request: () => requestCardReveal(api, organizationId, cardId),
    confirm: async (challenge, assertion) => {
      onSession(
        await confirmCardReveal(
          api,
          organizationId,
          cardId,
          challenge.challengeId,
          assertion,
        ),
      );
    },
  });
}
