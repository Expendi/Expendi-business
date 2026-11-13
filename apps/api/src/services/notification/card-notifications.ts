import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { formatUsdAmount, formatUsdCents } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { OutgoingNotification } from "./outgoing.js";
import {
  bills,
  cardPurchases,
  cards,
  payees,
  recurringItems,
} from "../../db/schema/index.js";
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
    }
  | {
      readonly kind: "card_purchase_needs_review";
      readonly organizationId: string;
      readonly purchaseId: string;
    }
  | {
      readonly kind: "card_bill_declined" | "card_purchase_over_estimate";
      readonly organizationId: string;
      readonly billId: string;
      readonly purchaseId: string;
    }
  | {
      readonly kind: "card_balance_short";
      readonly organizationId: string;
      /** The Nairobi day of the check; one warning a day at most. */
      readonly today: string;
      /** What the company-held cards' recurring payments need soon. */
      readonly dueUsdCents: bigint;
      readonly availableUsdCents: bigint;
    };

const ADMINS = { to: "admins", exceptMembershipId: null } as const;

const MERCHANT_SHOWN_MAX = 40;

/**
 * A merchant's descriptor as a notification prints it. The merchant writes
 * it, and it lands in push and email bodies: quoted, so it can't pass for
 * our words, cut short, and left with letters, digits, spaces and
 * `&'-.*#` only. A slash becomes a space and a dot before a letter or digit
 * gets one after it, so a mail client can't make a link of a domain or a
 * path.
 */
export function merchantShown(descriptor: string): string {
  const shown = descriptor
    .replace(/[\s/]/g, " ")
    .replace(/[^\p{L}\p{N} &'\-.*#]/gu, "")
    .replace(/\.(?=[\p{L}\p{N}])/gu, ". ")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, MERCHANT_SHOWN_MAX)
    .trim();
  return `"${shown === "" ? "Unknown merchant" : shown}"`;
}

const notBelowZero = (cents: bigint) => (cents < 0n ? 0n : cents);

/** The bill a company-held card's purchase paid, or was declined for. */
function cardBill(
  tx: Transaction,
  organizationId: string,
  billId: string,
  purchaseId: string,
) {
  return query(() =>
    tx
      .select({
        payeeName: payees.name,
        amountUsdc: bills.amountUsdc,
        cardDeclineReason: bills.cardDeclineReason,
        recurringAmountUsdc: recurringItems.amountUsdc,
        cardId: cardPurchases.cardId,
        declineReason: cardPurchases.declineReason,
        settledUsdCents: cardPurchases.settledUsdCents,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .innerJoin(
        cardPurchases,
        and(
          eq(cardPurchases.id, purchaseId),
          eq(cardPurchases.organizationId, organizationId),
        ),
      )
      .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
      .where(
        and(eq(bills.id, billId), eq(bills.organizationId, organizationId)),
      )
      .limit(1),
  ).pipe(Effect.map(([row]) => row ?? null));
}

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
        cardName: cards.nickname,
      })
      .from(cardPurchases)
      .innerJoin(cards, eq(cards.id, cardPurchases.cardId))
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

    if (event.kind === "card_balance_short") {
      return [
        {
          audience: ADMINS,
          title: "Not enough on the Card balance",
          body: `Your company-held cards' recurring payments need ${formatUsdCents(event.dueUsdCents)} soon, and ${formatUsdCents(notBelowZero(event.availableUsdCents))} is left. Load more so they aren't declined.`,
          data: { type: event.kind, organizationId },
          alsoByEmail: true,
          dedupeKey: `card_balance_short:${event.today}`,
        },
      ];
    }

    if (
      event.kind === "card_bill_declined" ||
      event.kind === "card_purchase_over_estimate"
    ) {
      const row = yield* cardBill(
        tx,
        organizationId,
        event.billId,
        event.purchaseId,
      );
      if (!row) return [];
      const data = {
        type: event.kind,
        organizationId,
        billId: event.billId,
        cardId: row.cardId,
        purchaseId: event.purchaseId,
      };
      if (event.kind === "card_bill_declined") {
        const reason = row.cardDeclineReason ?? row.declineReason;
        // A declined purchase moved no money, so the bill says how much.
        const payment =
          row.amountUsdc === null
            ? `A Card purchase for ${row.payeeName}`
            : `${formatUsdAmount(row.amountUsdc)} to ${row.payeeName}`;
        return [
          {
            audience: ADMINS,
            title: "A Card purchase was declined",
            body: `${payment} didn't go through${reason ? `: ${reason}` : "."} The bill is still unpaid.`,
            data,
            alsoByEmail: true,
            dedupeKey: `card_bill_declined:${event.purchaseId}`,
          },
        ];
      }
      const paid =
        row.amountUsdc === null
          ? formatUsdCents(row.settledUsdCents)
          : formatUsdAmount(row.amountUsdc);
      const estimate =
        row.recurringAmountUsdc === null
          ? ""
          : `, more than its estimate of ${formatUsdAmount(row.recurringAmountUsdc)}`;
      return [
        {
          audience: ADMINS,
          title: "A Card purchase was more than expected",
          body: `${row.payeeName}'s Card purchase was ${paid}${estimate}. Check the price hasn't gone up.`,
          data,
          alsoByEmail: true,
          dedupeKey: `card_purchase_over_estimate:${event.purchaseId}`,
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
      // A company-held card has nobody to hand it to.
      if (card?.membershipId == null) return [];
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
    // A company-held card's purchases are the admins' to answer for.
    const audience =
      purchase.membershipId === null
        ? ADMINS
        : ({ to: "member", membershipId: purchase.membershipId } as const);
    const amount = formatUsdCents(
      purchase.settledUsdCents + purchase.holdUsdCents,
    );
    const merchant = merchantShown(purchase.merchant);

    switch (event.kind) {
      case "card_receipt_needed":
        return [
          {
            audience,
            title: "Add your receipt",
            body: `${amount} at ${merchant}. Add the receipt while you have it.`,
            data,
            dedupeKey: `card_receipt_needed:${event.purchaseId}`,
          },
        ];
      case "card_receipt_reminder":
        return [
          {
            audience,
            title: "A card receipt is still missing",
            body: `${amount} at ${merchant} needs its receipt.`,
            data,
            dedupeKey: `card_receipt_reminder:${event.purchaseId}:${event.today}`,
          },
        ];
      case "card_purchase_declined":
        return [
          {
            audience,
            title: "Card purchase declined",
            body: purchase.declineReason
              ? `${merchant}: ${purchase.declineReason}`
              : `Your purchase at ${merchant} was declined.`,
            data,
            dedupeKey: `card_purchase_declined:${event.purchaseId}`,
          },
        ];
      case "card_purchase_needs_review":
        return [
          {
            audience: ADMINS,
            title: "Is this a recurring payment?",
            body: `A purchase on ${purchase.cardName} needs an answer: is ${merchant} one of its recurring payments?`,
            data,
            alsoByEmail: true,
            dedupeKey: `card_purchase_needs_review:${event.purchaseId}`,
          },
        ];
      case "card_refund_received":
        return [
          {
            audience: ADMINS,
            title: "A card refund arrived",
            body: `${amount} from ${merchant} went back to the Card balance. The books aren't adjusted, so check it with your accountant.`,
            data,
            alsoByEmail: true,
            dedupeKey: `card_refund_received:${event.purchaseId}`,
          },
        ];
    }
  });
}
