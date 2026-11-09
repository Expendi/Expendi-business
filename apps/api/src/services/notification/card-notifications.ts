import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { formatUsdCents } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { OutgoingNotification } from "./outgoing.js";
import { cardPurchases, cards } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * Expendi cards (spec §6.25). Cardholders hear about their own cards and
 * purchases; admins hear when the Card balance runs low or a refund arrives,
 * by email too. Each is sent at most once (its `dedupeKey`).
 */
export type CardNotificationEvent =
  | {
      readonly kind: "card_issued";
      readonly organizationId: string;
      readonly cardId: string;
    }
  | {
      readonly kind:
        | "card_receipt_needed"
        | "card_purchase_declined"
        | "card_refund_received";
      readonly organizationId: string;
      readonly purchaseId: string;
    }
  | {
      readonly kind: "card_receipt_reminder";
      readonly organizationId: string;
      readonly purchaseId: string;
      /** The Nairobi day of the reminder; one a day at most. */
      readonly today: string;
    }
  | {
      readonly kind: "card_balance_low";
      readonly organizationId: string;
      /** The Nairobi day of the check; one warning a day at most. */
      readonly today: string;
      readonly availableUsdCents: bigint;
    };

const ADMINS = { to: "admins", exceptMembershipId: null } as const;

function purchaseFor(
  tx: Transaction,
  organizationId: string,
  purchaseId: string,
) {
  return query(() =>
    tx
      .select({
        cardId: cardPurchases.cardId,
        membershipId: cardPurchases.membershipId,
        merchant: cardPurchases.merchant,
        holdUsdCents: cardPurchases.holdUsdCents,
        settledUsdCents: cardPurchases.settledUsdCents,
        declineReason: cardPurchases.declineReason,
      })
      .from(cardPurchases)
      .where(
        and(
          eq(cardPurchases.id, purchaseId),
          eq(cardPurchases.organizationId, organizationId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map(([purchase]) => purchase ?? null));
}

export function cardNotifications(
  tx: Transaction,
  event: CardNotificationEvent,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  const { organizationId } = event;
  return Effect.gen(function* () {
    if (event.kind === "card_balance_low") {
      return [
        {
          audience: ADMINS,
          title: "Card balance is low",
          body: `${formatUsdCents(event.availableUsdCents < 0n ? 0n : event.availableUsdCents)} left for your Expendi cards. Load more to keep them working.`,
          data: { type: event.kind, organizationId },
          alsoByEmail: true,
          dedupeKey: `card_balance_low:${event.today}`,
        },
      ];
    }

    if (event.kind === "card_issued") {
      const [card] = yield* query(() =>
        tx
          .select({
            membershipId: cards.membershipId,
            nickname: cards.nickname,
            lastFour: cards.lastFour,
          })
          .from(cards)
          .where(
            and(
              eq(cards.id, event.cardId),
              eq(cards.organizationId, organizationId),
            ),
          )
          .limit(1),
      );
      if (!card) return [];
      return [
        {
          audience: { to: "member", membershipId: card.membershipId } as const,
          title: "You have a new Expendi card",
          body: `${card.nickname}, ending ${card.lastFour}, is ready to use.`,
          data: { type: event.kind, organizationId, cardId: event.cardId },
          dedupeKey: `card_issued:${event.cardId}`,
        },
      ];
    }

    const purchase = yield* purchaseFor(tx, organizationId, event.purchaseId);
    if (!purchase) return [];
    const data = {
      type: event.kind,
      organizationId,
      cardId: purchase.cardId,
      purchaseId: event.purchaseId,
    };
    const member = {
      to: "member",
      membershipId: purchase.membershipId,
    } as const;
    const amount = formatUsdCents(
      purchase.settledUsdCents + purchase.holdUsdCents,
    );

    switch (event.kind) {
      case "card_receipt_needed":
        return [
          {
            audience: member,
            title: "Add your receipt",
            body: `${amount} at ${purchase.merchant}. Add the receipt while you have it.`,
            data,
            dedupeKey: `card_receipt_needed:${event.purchaseId}`,
          },
        ];
      case "card_receipt_reminder":
        return [
          {
            audience: member,
            title: "A card receipt is still missing",
            body: `${amount} at ${purchase.merchant} needs its receipt.`,
            data,
            dedupeKey: `card_receipt_reminder:${event.purchaseId}:${event.today}`,
          },
        ];
      case "card_purchase_declined":
        return [
          {
            audience: member,
            title: "Card purchase declined",
            body: purchase.declineReason
              ? `${purchase.merchant}: ${purchase.declineReason}`
              : `Your purchase at ${purchase.merchant} was declined.`,
            data,
            dedupeKey: `card_purchase_declined:${event.purchaseId}`,
          },
        ];
      case "card_refund_received":
        return [
          {
            audience: ADMINS,
            title: "A card refund arrived",
            body: `${amount} from ${purchase.merchant} went back to the Card balance. The books aren't adjusted, so check it with your accountant.`,
            data,
            alsoByEmail: true,
            dedupeKey: `card_refund_received:${event.purchaseId}`,
          },
        ];
    }
  });
}
