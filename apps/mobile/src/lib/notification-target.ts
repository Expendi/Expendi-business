import type { Href } from "expo-router";

import type { CardNotificationData } from "@expendi-business/shared";
import {
  cardNotificationDataSchema,
  pushNotificationDataSchema,
} from "@expendi-business/shared";

import { queryKeys } from "./query-keys";

/** What a tapped notification opens, in the company it's about. */
export type NotificationTarget =
  | {
      readonly kind: "claim";
      readonly organizationId: string;
      readonly claimId: string;
    }
  | {
      readonly kind: "card_purchase";
      readonly organizationId: string;
      readonly purchaseId: string;
      readonly cardId: string | null;
    }
  | {
      readonly kind: "card";
      readonly organizationId: string;
      readonly cardId: string;
    }
  | { readonly kind: "cards"; readonly organizationId: string };

/** These go to admins, who needn't hold the card, so only the cards screen is theirs. */
function isForAdmins(type: CardNotificationData["type"]): boolean {
  return type === "card_balance_low" || type === "card_refund_received";
}

function cardTarget(data: CardNotificationData): NotificationTarget {
  const { type, organizationId, cardId, purchaseId } = data;
  if (!isForAdmins(type)) {
    if (purchaseId) {
      return {
        kind: "card_purchase",
        organizationId,
        purchaseId,
        cardId: cardId ?? null,
      };
    }
    if (cardId) return { kind: "card", organizationId, cardId };
  }
  return { kind: "cards", organizationId };
}

/** Null for anything this version of the app can't open. */
export function notificationTarget(data: unknown): NotificationTarget | null {
  const claim = pushNotificationDataSchema.safeParse(data);
  if (claim.success) {
    return {
      kind: "claim",
      organizationId: claim.data.organizationId,
      claimId: claim.data.claimId,
    };
  }
  const card = cardNotificationDataSchema.safeParse(data);
  return card.success ? cardTarget(card.data) : null;
}

export function notificationHref(target: NotificationTarget): Href {
  switch (target.kind) {
    case "claim":
      return {
        pathname: "/claims/[claimId]",
        params: { claimId: target.claimId },
      };
    case "card_purchase":
      return {
        pathname: "/cards/purchases/[purchaseId]",
        params: target.cardId
          ? { purchaseId: target.purchaseId, cardId: target.cardId }
          : { purchaseId: target.purchaseId },
      };
    case "card":
      return { pathname: "/cards/[cardId]", params: { cardId: target.cardId } };
    case "cards":
      return "/cards";
  }
}

/** What a notification makes out of date, so the screen it opens is current. */
export function notificationQueryKey(
  target: NotificationTarget,
): readonly unknown[] {
  return target.kind === "claim"
    ? queryKeys.claims(target.organizationId)
    : queryKeys.cards(target.organizationId);
}
