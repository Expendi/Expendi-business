import type { InfiniteData } from "@tanstack/react-query";
import { z } from "zod";

import type {
  AttachCardReceiptRequest,
  CardActionRequest,
  CardConfirmation,
  CardList,
  CardPurchase,
  CardPurchaseList,
} from "@expendi-business/shared";
import {
  cardActionResultSchema,
  cardConfirmationSchema,
  cardListSchema,
  cardPurchaseListSchema,
  cardPurchaseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "../../lib/api";
import { ApiError } from "../../lib/api";

/** The cardholder's side of Expendi cards (spec §6.25). Every list is the caller's own. */

function cardsPath(organizationId: string) {
  return `/organizations/${organizationId}/cards` as const;
}

export function listMyCards(
  api: ApiClient,
  organizationId: string,
): Promise<CardList> {
  return api.get(`${cardsPath(organizationId)}?mine=true`, cardListSchema);
}

export interface CardPurchaseFilters {
  readonly cardId?: string | undefined;
  readonly needsReceipt?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export function listMyCardPurchases(
  api: ApiClient,
  organizationId: string,
  { cardId, needsReceipt, limit, cursor }: CardPurchaseFilters,
): Promise<CardPurchaseList> {
  const params = ["mine=true"];
  if (cardId) params.push(`cardId=${encodeURIComponent(cardId)}`);
  if (needsReceipt) params.push("needsReceipt=true");
  if (limit) params.push(`limit=${limit}`);
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return api.get(
    `${cardsPath(organizationId)}/purchases?${params.join("&")}`,
    cardPurchaseListSchema,
  );
}

/**
 * There's no route for one purchase, so a screen opened from a push looks
 * through the holder's purchases, newest first, and gives up after a few
 * pages rather than walking years of history.
 */
export async function findMyCardPurchase(
  api: ApiClient,
  organizationId: string,
  purchaseId: string,
): Promise<CardPurchase | null> {
  try {
    return await api.get(
      `/organizations/${organizationId}/cards/purchases/${purchaseId}`,
      cardPurchaseSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The purchase, if a list already on screen has loaded it. */
export function findLoadedPurchase(
  lists: readonly (InfiniteData<CardPurchaseList> | undefined)[],
  purchaseId: string,
): CardPurchase | undefined {
  for (const list of lists) {
    for (const page of list?.pages ?? []) {
      const found = page.purchases.find(({ id }) => id === purchaseId);
      if (found) return found;
    }
  }
  return undefined;
}

/** A holder can freeze their own card; nothing here needs what the API answers. */
export async function freezeCard(
  api: ApiClient,
  organizationId: string,
  cardId: string,
): Promise<void> {
  await api.post(
    `${cardsPath(organizationId)}/${cardId}/freeze`,
    undefined,
    z.unknown(),
  );
}

export function requestCardReveal(
  api: ApiClient,
  organizationId: string,
  cardId: string,
): Promise<CardConfirmation> {
  const action: CardActionRequest = { type: "reveal_card", cardId };
  return api.post(
    `${cardsPath(organizationId)}/confirmations`,
    action,
    cardConfirmationSchema,
  );
}

/** Only ever handed to the card-details WebView; see `RevealedCardDetails`. */
export interface RevealSession {
  readonly url: string;
  readonly expiresAt: string;
}

export async function confirmCardReveal(
  api: ApiClient,
  organizationId: string,
  cardId: string,
  challengeId: string,
  response: unknown,
): Promise<RevealSession> {
  const action: CardActionRequest = { type: "reveal_card", cardId };
  const result = await api.post(
    `${cardsPath(organizationId)}/confirmations/${challengeId}`,
    { action, response },
    cardActionResultSchema,
  );
  if (result.type !== "reveal_card") {
    throw new ApiError(
      200,
      "InvalidResponse",
      "The server sent a response this version of the app can't read.",
    );
  }
  return { url: result.revealUrl, expiresAt: result.expiresAt };
}

/** `categoryId` goes only if the holder changed it: it can't change later. */
export function attachReceiptRequest(
  receiptFileIds: readonly string[],
  categoryId: string,
  currentCategoryId: string,
): AttachCardReceiptRequest {
  return {
    receiptFileIds: [...receiptFileIds],
    ...(categoryId === currentCategoryId ? {} : { categoryId }),
  };
}

export async function attachCardReceipt(
  api: ApiClient,
  organizationId: string,
  purchaseId: string,
  request: AttachCardReceiptRequest,
): Promise<void> {
  await api.post(
    `${cardsPath(organizationId)}/purchases/${purchaseId}/receipts`,
    request,
    z.unknown(),
  );
}
