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
  | { readonly kind: "cards"; readonly organizationId: string }
  | {
      readonly kind: "bill";
      readonly organizationId: string;
      readonly billId: string;
    }
  | { readonly kind: "bills"; readonly organizationId: string }
  | { readonly kind: "overview"; readonly organizationId: string };

/** These go to admins, who needn't hold the card, so only the cards screen is theirs. */
function isForAdmins(type: CardNotificationData["type"]): boolean {
  return type === "card_balance_low" || type === "card_refund_received";
}

/**
 * About a company-held card, which has no cardholder and no screen in the
 * app, so its admins land on the bill it pays, the bills, or the overview's
 * cash check; never on a cardholder's cards.
 */
function companyHeldCardTarget(
  data: CardNotificationData,
): NotificationTarget | null {
  const { type, organizationId, billId } = data;
  switch (type) {
    case "card_bill_declined":
    case "card_purchase_over_estimate":
      return billId
        ? { kind: "bill", organizationId, billId }
        : { kind: "bills", organizationId };
    case "card_purchase_needs_review":
      return { kind: "bills", organizationId };
    case "card_balance_short":
      return { kind: "overview", organizationId };
    default:
      return null;
  }
}

function cardTarget(data: CardNotificationData): NotificationTarget {
  const companyHeld = companyHeldCardTarget(data);
  if (companyHeld) return companyHeld;
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
    case "bill":
      return { pathname: "/bills/[billId]", params: { billId: target.billId } };
    case "bills":
      return "/bills";
    case "overview":
      return "/";
  }
}

/** What a notification makes out of date, so the screen it opens is current. */
export function notificationQueryKey(
  target: NotificationTarget,
): readonly unknown[] {
  switch (target.kind) {
    case "claim":
      return queryKeys.claims(target.organizationId);
    case "bill":
    case "bills":
      return queryKeys.bills(target.organizationId);
    case "overview":
      return queryKeys.overview(target.organizationId);
    case "card_purchase":
    case "card":
    case "cards":
      return queryKeys.cards(target.organizationId);
  }
}
