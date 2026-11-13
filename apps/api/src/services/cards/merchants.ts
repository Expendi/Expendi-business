import { and, count, eq, gte, ne } from "drizzle-orm";
import { Effect } from "effect";

import type { CardPurchaseReviewState } from "@expendi-business/shared";

import type { CardMerchant, CardPurchase } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  cardMerchants,
  cardPurchases,
  recurringItems,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { notify } from "../notification/notify.js";
import {
  hasEndedForCardsSql,
  hasNotEndedForCardsSql,
} from "../recurring/card-paid-state.js";

/**
 * A company-held card knows the merchants its Card purchases come from
 * (spec §6.20, §6.25). A merchant linked to one of the card's recurring
 * payments pays that payment's bills; any other is a one-off, blocked as
 * not recognised, or still waiting for an admin to say which.
 *
 * Lock order, for every path that touches a recurring payment's merchants
 * and its bills: the company's card program (`lockCardProgram`), on the
 * paths that take it; then the card's merchants (`card_merchants`); then
 * the merchant's purchases, oldest first (`authorized_at`, then `id`); then
 * the payment's bill still owed; then the recurring payment itself, which
 * is `next-bill.ts`'s bill-then-item order with the rest in front. A
 * purchase only learns which payment's bill it's for from its merchant, so
 * the merchant can't come later. Taking them in one order everywhere means
 * two of these paths wait for each other instead of deadlocking:
 *
 * - a Card purchase arriving (`transactions.ts`): the card program, then
 *   its merchant, then, when declined, the bill it was meant for. It
 *   writes its own row before its merchant's, which can't deadlock with an
 *   answer: it only goes on to the merchant while the purchase has no
 *   answer and pays nothing, the kind of purchase no answer ever locks, and
 *   no answer takes the card program;
 * - a settled purchase (`payBillByCard`): the purchase, then the bill, then
 *   the payment; its merchant was settled when it was matched;
 * - an admin's answer (`review.ts`): the merchant, then the purchases it
 *   answers in one statement, then the bill each pays, then the payment;
 * - setting up, switching or moving a payment by card (`createRecurringItem`,
 *   `updateRecurringItem`): the card program, so a card's first purchase
 *   sees which payments the card pays before or after the change, never
 *   during it; then the merchants of the cards involved, then the bill,
 *   then the payment.
 */

/**
 * Lithic's merchant ID when it sends one: a merchant's descriptor can
 * change from one Card purchase to the next, its ID doesn't. The descriptor
 * stands in only when there's no ID.
 */
export function merchantKeyOf(
  acceptorId: string | null | undefined,
  descriptor: string | null | undefined,
): string {
  const id = acceptorId?.trim() ?? "";
  return id === "" ? `name:${(descriptor ?? "").trim().toUpperCase()}` : id;
}

/**
 * Whether the card turns this merchant away: an admin didn't recognise it,
 * or the recurring payment it's linked to is paused, has ended, or is no
 * longer paid by this card. One indexed read, for the purchase check.
 */
export function merchantRefused(
  tx: Transaction,
  cardId: string,
  merchantKey: string,
): Effect.Effect<boolean, DatabaseError> {
  return query(() =>
    tx
      .select({
        blocked: cardMerchants.blocked,
        recurringItemId: cardMerchants.recurringItemId,
        active: recurringItems.active,
        ended: hasEndedForCardsSql(),
        paidByCardId: recurringItems.cardId,
      })
      .from(cardMerchants)
      .leftJoin(
        recurringItems,
        eq(recurringItems.id, cardMerchants.recurringItemId),
      )
      .where(
        and(
          eq(cardMerchants.cardId, cardId),
          eq(cardMerchants.merchantKey, merchantKey),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map(([merchant]) => {
      if (!merchant) return false;
      if (merchant.blocked) return true;
      return (
        merchant.recurringItemId !== null &&
        (merchant.active !== true ||
          merchant.ended ||
          merchant.paidByCardId !== cardId)
      );
    }),
  );
}

type Match =
  | { readonly recurringItemId: string }
  | {
      readonly reviewState: CardPurchaseReviewState;
      /**
       * Admins are asked about a merchant once: at its first Card purchase,
       * or the first after it stopped paying a recurring payment.
       */
      readonly ask: boolean;
    };

/**
 * Held or settled. Only such a purchase registers a merchant with the card
 * or asks about one: a stranger the card declined mustn't take a
 * one-payment card's link, nor leave admins a question about nothing spent.
 */
const approved = (purchase: Pick<CardPurchase, "status">): boolean =>
  purchase.status === "pending" || purchase.status === "settled";

/** The card's recurring payments that haven't ended, paused or not. */
function paymentsOnCard(
  tx: Transaction,
  organizationId: string,
  cardId: string,
) {
  return query(() =>
    tx
      .select({ id: recurringItems.id })
      .from(recurringItems)
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          eq(recurringItems.cardId, cardId),
          hasNotEndedForCardsSql(),
        ),
      )
      .limit(2),
  );
}

/**
 * An admin's one-off answer about the merchant that still stands: given
 * since its row last changed. Every link, release or block rewrites the
 * row (`updated_at`), and an answer sets it to the answer's own time, so
 * one given before the merchant paid a recurring payment no longer counts
 * once that payment lets it go.
 */
function earlierAnswer(
  tx: Transaction,
  merchant: CardMerchant,
): Effect.Effect<CardPurchaseReviewState | null, DatabaseError> {
  return query(() =>
    tx
      .select({ reviewState: cardPurchases.reviewState })
      .from(cardPurchases)
      .innerJoin(cardMerchants, eq(cardMerchants.id, merchant.id))
      .where(
        and(
          eq(cardPurchases.cardId, merchant.cardId),
          eq(cardPurchases.merchantKey, merchant.merchantKey),
          eq(cardPurchases.reviewState, "one_off"),
          gte(cardPurchases.reviewedAt, cardMerchants.updatedAt),
        ),
      )
      .limit(1),
  ).pipe(Effect.map(([row]) => row?.reviewState ?? null));
}

/** Another of the merchant's purchases on the card already waits for an answer. */
function alreadyAsked(
  tx: Transaction,
  purchase: CardPurchase,
  merchantKey: string,
): Effect.Effect<boolean, DatabaseError> {
  return query(() =>
    tx
      .select({ id: cardPurchases.id })
      .from(cardPurchases)
      .where(
        and(
          eq(cardPurchases.cardId, purchase.cardId),
          eq(cardPurchases.merchantKey, merchantKey),
          eq(cardPurchases.reviewState, "needs_review"),
          ne(cardPurchases.id, purchase.id),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

/** Null leaves the purchase as it is: declined by a merchant nobody answered for. */
function decide(
  tx: Transaction,
  purchase: CardPurchase,
  merchantKey: string,
): Effect.Effect<Match | null, DatabaseError> {
  const { organizationId, cardId } = purchase;
  return Effect.gen(function* () {
    const [merchant] = yield* query(() =>
      tx
        .select()
        .from(cardMerchants)
        .where(
          and(
            eq(cardMerchants.cardId, cardId),
            eq(cardMerchants.merchantKey, merchantKey),
          ),
        )
        .for("update"),
    );
    if (merchant) {
      if (merchant.recurringItemId !== null) {
        return { recurringItemId: merchant.recurringItemId };
      }
      if (merchant.blocked)
        return { reviewState: "not_recognised", ask: false };
      const answer = yield* earlierAnswer(tx, merchant);
      if (answer !== null) return { reviewState: answer, ask: false };
      if (!approved(purchase)) return null;
      return {
        reviewState: "needs_review",
        ask: !(yield* alreadyAsked(tx, purchase, merchantKey)),
      };
    }
    if (!approved(purchase)) return null;

    const [seen] = yield* query(() =>
      tx
        .select({ merchants: count() })
        .from(cardMerchants)
        .where(eq(cardMerchants.cardId, cardId)),
    );
    const payments = yield* paymentsOnCard(tx, organizationId, cardId);
    // A card that pays one thing can only be used for that thing.
    const [only] = payments;
    const linkTo =
      seen?.merchants === 0 && payments.length === 1 && only ? only.id : null;
    yield* query(() =>
      tx
        .insert(cardMerchants)
        .values({
          organizationId,
          cardId,
          merchantKey,
          descriptor: purchase.merchant,
          recurringItemId: linkTo,
        })
        .onConflictDoNothing({
          target: [cardMerchants.cardId, cardMerchants.merchantKey],
        }),
    );
    return linkTo === null
      ? { reviewState: "needs_review", ask: true }
      : { recurringItemId: linkTo };
  });
}

/**
 * Says what a company-held card's purchase is, the first time it's seen
 * with its merchant: one of the card's recurring payments, or what admins
 * said about the merchant before, or a question for them. Runs under the
 * company's card program lock (`upsertPurchase`), so two purchases from a
 * new merchant can't both ask, and a payment can't move off the card while
 * its first merchant is linked to it. Anything already decided is left as
 * it is, and so is a declined purchase from a merchant nobody has answered
 * for.
 */
export function matchCompanyHeldPurchase(
  tx: Transaction,
  purchase: CardPurchase,
): Effect.Effect<CardPurchase, DatabaseError> {
  const { merchantKey } = purchase;
  if (
    purchase.membershipId !== null ||
    purchase.kind !== "purchase" ||
    merchantKey === null ||
    purchase.recurringItemId !== null ||
    purchase.reviewState !== null
  ) {
    return Effect.succeed(purchase);
  }
  return Effect.gen(function* () {
    const match = yield* decide(tx, purchase, merchantKey);
    if (match === null) return purchase;
    const [matched] = yield* query(() =>
      tx
        .update(cardPurchases)
        .set(
          "recurringItemId" in match
            ? { recurringItemId: match.recurringItemId }
            : { reviewState: match.reviewState },
        )
        .where(eq(cardPurchases.id, purchase.id))
        .returning(),
    );
    if (!matched) return yield* Effect.dieMessage("match wrote no row");
    if ("ask" in match && match.ask) {
      yield* notify(tx, {
        kind: "card_purchase_needs_review",
        organizationId: purchase.organizationId,
        purchaseId: purchase.id,
      });
    }
    return matched;
  });
}
