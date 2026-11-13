import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { Effect } from "effect";

import type { CardPurchaseReview } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CardMerchant, CardPurchase } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { CardPurchaseView } from "./purchases.js";
import {
  accountingSyncs,
  cardMerchants,
  cardPurchases,
  cards,
  expenses,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { payBillByCard } from "../bills/card-payment.js";
import { notify } from "../notification/notify.js";
import { hasEndedForCardsSql } from "../recurring/card-paid-state.js";
import { enqueueRecordedSpending } from "../zoho/enqueue.js";
import { NOT_RECOGNISED_REASON } from "./card-expense.js";
import { userActor } from "./manage.js";
import { getCardPurchase, needsReceiptSql } from "./purchases.js";
import { purchaseReceiptCount } from "./transactions.js";

/**
 * An admin saying what a merchant a company-held card hadn't seen is (spec
 * §6.25): one of the card's recurring payments, a one-off, or not
 * recognised. The answer is the merchant's, so it goes to every purchase of
 * the merchant's on the card still waiting for one, and to later ones.
 *
 * Linking a purchase that already has a Card expense makes that expense the
 * bill's payment, unless the expense is already queued for Zoho or there,
 * or the purchase's amount changed after it was recorded: then it stays a
 * one-off Card expense, and only later purchases match.
 *
 * A merchant linked to a payment, by the card's first purchase or by an
 * admin, can still be not recognised: it's unlinked and blocked, and its
 * purchases that haven't paid a bill become not recognised. A bill one of
 * them already paid stays paid; the books aren't rewritten.
 */

/**
 * The most purchases one answer goes to, oldest first, so one transaction
 * stays short; the rest keep waiting and the next answer takes them.
 */
const MAX_ANSWERED_AT_ONCE = 50;

const purchaseNotFound = new NotFound({
  message: "That purchase wasn't found.",
});
const notCompanyHeld = new Conflict({
  message: "Only a purchase on a company-held card is answered for this way.",
});
const alreadyMatched = new Conflict({
  message: "This purchase already pays one of the card's recurring payments.",
});
const notRecognisedAlready = new Conflict({
  message:
    "An admin already said they don't recognise this merchant, so it's declined on this card.",
});
const notYetSeen = new Conflict({
  message:
    "This purchase hasn't reached Expendi from the card issuer yet. Try again in a minute.",
});
const notThisCard = new BadRequest({
  message: "Pick one of this card's recurring payments.",
});
const paymentEnded = new Conflict({
  message: "That recurring payment has ended. Pick one that's still running.",
});
const linkedElsewhere = new Conflict({
  message:
    "This merchant already pays another of the card's recurring payments.",
});

type Outcome =
  | "matched"
  | "paid_bill"
  | "kept_card_expense"
  | "one_off"
  | "not_recognised"
  | "bill_stays_paid";

function readyForReview(
  tx: Transaction,
  purchase: CardPurchase,
  review: CardPurchaseReview,
): Effect.Effect<string, Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [card] = yield* query(() =>
      tx
        .select({ companyHeld: cards.companyHeld })
        .from(cards)
        .where(eq(cards.id, purchase.cardId))
        .limit(1),
    );
    if (!card?.companyHeld || purchase.kind !== "purchase") {
      return yield* Effect.fail(notCompanyHeld);
    }
    if (
      purchase.recurringItemId !== null &&
      review.decision !== "not_recognised"
    ) {
      return yield* Effect.fail(alreadyMatched);
    }
    if (purchase.reviewState === "not_recognised") {
      return yield* Effect.fail(notRecognisedAlready);
    }
    if (
      (purchase.reviewState === null && purchase.recurringItemId === null) ||
      purchase.merchantKey === null
    ) {
      return yield* Effect.fail(notYetSeen);
    }
    return purchase.merchantKey;
  });
}

function lockMerchant(
  tx: Transaction,
  purchase: CardPurchase,
  merchantKey: string,
): Effect.Effect<CardMerchant, DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(cardMerchants)
      .where(
        and(
          eq(cardMerchants.cardId, purchase.cardId),
          eq(cardMerchants.merchantKey, merchantKey),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(([merchant]) =>
      merchant
        ? Effect.succeed(merchant)
        : Effect.dieMessage(`purchase ${purchase.id}: its merchant vanished`),
    ),
  );
}

function readCardPurchase(
  tx: Transaction,
  organizationId: string,
  purchaseId: string,
): Effect.Effect<CardPurchase | null, DatabaseError> {
  return query(() =>
    tx
      .select()
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

/**
 * The purchase answered, and the merchant's other purchases on the card the
 * answer also goes to (up to `MAX_ANSWERED_AT_ONCE` of them): those still
 * waiting for one, and, when it isn't recognised, those it matched that
 * haven't paid a bill yet. Locked in one statement, oldest first, the order
 * in `merchants.ts`; oldest first is also how they're answered, so each
 * pays the bill of its own cycle, the open bill being chosen by when the
 * purchase settled.
 */
function lockAnswered(
  tx: Transaction,
  purchase: CardPurchase,
  merchantKey: string,
  review: CardPurchaseReview,
): Effect.Effect<CardPurchase[], DatabaseError> {
  const ofMerchant = and(
    eq(cardPurchases.cardId, purchase.cardId),
    eq(cardPurchases.merchantKey, merchantKey),
  );
  const waiting = eq(cardPurchases.reviewState, "needs_review");
  const alsoAnswered =
    review.decision === "not_recognised"
      ? or(
          waiting,
          and(
            isNotNull(cardPurchases.recurringItemId),
            isNull(cardPurchases.billId),
          ),
        )
      : waiting;
  const oldestOthers = tx
    .select({ id: cardPurchases.id })
    .from(cardPurchases)
    .where(and(ofMerchant, alsoAnswered, ne(cardPurchases.id, purchase.id)))
    .orderBy(cardPurchases.authorizedAt, cardPurchases.id)
    .limit(MAX_ANSWERED_AT_ONCE);
  return query(() =>
    tx
      .select()
      .from(cardPurchases)
      .where(
        and(
          ofMerchant,
          or(
            eq(cardPurchases.id, purchase.id),
            and(alsoAnswered, inArray(cardPurchases.id, oldestOthers)),
          ),
        ),
      )
      .orderBy(cardPurchases.authorizedAt, cardPurchases.id)
      .for("update"),
  );
}

function checkLinkTarget(
  tx: Transaction,
  purchase: CardPurchase,
  merchant: CardMerchant,
  recurringItemId: string,
): Effect.Effect<void, BadRequest | Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [item] = yield* query(() =>
      tx
        .select({
          cardId: recurringItems.cardId,
          ended: hasEndedForCardsSql(),
        })
        .from(recurringItems)
        .where(
          and(
            eq(recurringItems.organizationId, purchase.organizationId),
            eq(recurringItems.id, recurringItemId),
          ),
        )
        .limit(1),
    );
    if (item?.cardId !== purchase.cardId) {
      return yield* Effect.fail(notThisCard);
    }
    if (item.ended) return yield* Effect.fail(paymentEnded);
    if (
      merchant.recurringItemId !== null &&
      merchant.recurringItemId !== recurringItemId
    ) {
      return yield* Effect.fail(linkedElsewhere);
    }
  });
}

/** Whether a Card expense is queued for Zoho, or already there. */
function reachedZoho(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
): Effect.Effect<boolean, DatabaseError> {
  return query(() =>
    tx
      .select({ id: accountingSyncs.id })
      .from(accountingSyncs)
      .where(
        and(
          eq(accountingSyncs.organizationId, organizationId),
          eq(accountingSyncs.subjectType, "expense"),
          eq(accountingSyncs.subjectId, expenseId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

function settledOnOf(
  tx: Transaction,
  expenseId: string,
): Effect.Effect<string, DatabaseError> {
  return query(() =>
    tx
      .select({ spentOn: expenses.spentOn })
      .from(expenses)
      .where(eq(expenses.id, expenseId))
      .limit(1),
  ).pipe(
    Effect.flatMap(([expense]) =>
      expense
        ? Effect.succeed(expense.spentOn)
        : Effect.dieMessage(`expense ${expenseId} vanished`),
    ),
  );
}

/**
 * A Card expense that can't become a bill's payment as it stands: its rate
 * isn't recorded, its amount moved after it was recorded (the bill would
 * take one amount and the books another), or it's queued for Zoho.
 */
function keepsCardExpense(
  tx: Transaction,
  purchase: CardPurchase,
  expenseId: string,
): Effect.Effect<boolean, DatabaseError> {
  if (
    purchase.usdKesRate === null ||
    purchase.changedAfterExpenseAt !== null ||
    purchase.settledUsdCents === 0n
  ) {
    return Effect.succeed(true);
  }
  return reachedZoho(tx, purchase.organizationId, expenseId);
}

function linkPurchase(
  tx: Transaction,
  tenant: Tenant,
  purchase: CardPurchase,
  recurringItemId: string,
  reviewedAt: Date,
): Effect.Effect<Outcome, DatabaseError, AuditLog> {
  const reviewed = { reviewedBy: tenant.userId, reviewedAt };
  const { expenseId, usdKesRate } = purchase;
  return Effect.gen(function* () {
    if (
      expenseId !== null &&
      (yield* keepsCardExpense(tx, purchase, expenseId))
    ) {
      yield* query(() =>
        tx
          .update(cardPurchases)
          .set({ reviewState: "one_off", ...reviewed })
          .where(eq(cardPurchases.id, purchase.id)),
      );
      return "kept_card_expense";
    }
    const [matched] = yield* query(() =>
      tx
        .update(cardPurchases)
        .set({ recurringItemId, reviewState: null, ...reviewed })
        .where(eq(cardPurchases.id, purchase.id))
        .returning(),
    );
    if (!matched) return yield* Effect.dieMessage("link wrote no row");
    // Not settled yet, or its expense not recorded yet: settling pays the bill.
    if (expenseId === null || usdKesRate === null) return "matched";
    yield* payBillByCard(tx, {
      purchase: matched,
      settledOn: yield* settledOnOf(tx, expenseId),
      rate: usdKesRate,
      cardExpenseId: expenseId,
    });
    return "paid_bill";
  });
}

function answer(
  tx: Transaction,
  tenant: Tenant,
  purchase: CardPurchase,
  review: CardPurchaseReview,
  reviewedAt: Date,
): Effect.Effect<Outcome, DatabaseError, AuditLog> {
  if (review.decision === "link") {
    return linkPurchase(
      tx,
      tenant,
      purchase,
      review.recurringItemId,
      reviewedAt,
    );
  }
  if (review.decision === "not_recognised" && purchase.billId !== null) {
    return Effect.succeed("bill_stays_paid");
  }
  const reviewState = review.decision;
  return Effect.gen(function* () {
    yield* query(() =>
      tx
        .update(cardPurchases)
        .set({
          reviewState,
          recurringItemId: null,
          reviewedBy: tenant.userId,
          reviewedAt,
        })
        .where(eq(cardPurchases.id, purchase.id)),
    );
    if (reviewState === "not_recognised") {
      yield* completeWithoutReceipt(tx, tenant, purchase);
    }
    return reviewState;
  });
}

/**
 * Nobody has a receipt for a purchase nobody recognises, so its Card
 * expense, if it has one and nothing else completed it, is completed with
 * that as its reason and goes to Zoho, as an admin's waiver would send it.
 * One that settles later gets the same as it's recorded
 * (`recordCardExpense`).
 */
function completeWithoutReceipt(
  tx: Transaction,
  tenant: Tenant,
  purchase: CardPurchase,
): Effect.Effect<void, DatabaseError, AuditLog> {
  const { organizationId, expenseId } = purchase;
  if (expenseId === null) return Effect.void;
  return Effect.gen(function* () {
    const [expense] = yield* query(() =>
      tx
        .select({ noReceiptReason: expenses.noReceiptReason })
        .from(expenses)
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.organizationId, organizationId),
          ),
        )
        .limit(1),
    );
    if (expense?.noReceiptReason !== null) return;
    if ((yield* purchaseReceiptCount(tx, organizationId, purchase.id)) > 0) {
      return;
    }
    yield* query(() =>
      tx
        .update(expenses)
        .set({ noReceiptReason: NOT_RECOGNISED_REASON })
        .where(eq(expenses.id, expenseId)),
    );
    yield* enqueueRecordedSpending(tx, organizationId, expenseId);
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: userActor(tenant),
      organizationId,
      action: "card_purchase.receipt_waived",
      entity: { type: "card_purchase", id: purchase.id },
      after: { noReceiptReason: NOT_RECOGNISED_REASON },
    });
  });
}

/**
 * A one-off asks admins for its receipt now, as any other Card purchase
 * does when it's made; while it waited for an answer it didn't.
 */
function askForReceipt(
  tx: Transaction,
  purchase: CardPurchase,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const [row] = yield* query(() =>
      tx
        .select({ needsReceipt: needsReceiptSql })
        .from(cardPurchases)
        .leftJoin(expenses, eq(expenses.id, cardPurchases.expenseId))
        .where(eq(cardPurchases.id, purchase.id))
        .limit(1),
    );
    if (!row?.needsReceipt) return;
    yield* notify(tx, {
      kind: "card_receipt_needed",
      organizationId: purchase.organizationId,
      purchaseId: purchase.id,
    });
  });
}

/**
 * `POST …/cards/purchases/:purchaseId/review`, admins only. Answers with
 * the purchase as it now is: after `link`, a `one_off` match means its Card
 * expense had already reached Zoho, or its amount changed since, and only
 * later purchases pay the bill. A purchase past the first
 * `MAX_ANSWERED_AT_ONCE` of its merchant's still waits.
 */
export function reviewCardPurchase(
  tenant: Tenant,
  purchaseId: string,
  review: CardPurchaseReview,
): Effect.Effect<
  CardPurchaseView,
  BadRequest | Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        // Read unlocked only to find the merchant: its lock comes before the
        // purchases' (`merchants.ts`), so two answers about one merchant
        // queue on it instead of each holding a purchase the other needs.
        const seen = yield* readCardPurchase(tx, organizationId, purchaseId);
        if (!seen) return yield* Effect.fail(purchaseNotFound);
        const merchantKey = yield* readyForReview(tx, seen, review);
        const merchant = yield* lockMerchant(tx, seen, merchantKey);
        const locked = yield* lockAnswered(tx, seen, merchantKey, review);
        const purchase = locked.find((each) => each.id === seen.id);
        if (!purchase) {
          return yield* Effect.dieMessage(`purchase ${seen.id} vanished`);
        }
        // An answer that held the merchant first may have answered this one.
        yield* readyForReview(tx, purchase, review);
        if (
          review.decision === "one_off" &&
          purchase.reviewState === "one_off"
        ) {
          return;
        }
        if (review.decision === "link") {
          yield* checkLinkTarget(
            tx,
            purchase,
            merchant,
            review.recurringItemId,
          );
        }
        // The row's `updated_at` is the answer's time, so a one-off answer
        // stands until the merchant next changes (`earlierAnswer`). Linking
        // a one-off from a merchant blocked since is the admin changing
        // their mind about it, so it's no longer blocked.
        const reviewedAt = new Date();
        yield* query(() =>
          tx
            .update(cardMerchants)
            .set({
              ...(review.decision === "link"
                ? { recurringItemId: review.recurringItemId, blocked: false }
                : review.decision === "not_recognised"
                  ? { recurringItemId: null, blocked: true }
                  : { blocked: false }),
              updatedAt: reviewedAt,
            })
            .where(eq(cardMerchants.id, merchant.id)),
        );

        const answered = locked.slice(0, MAX_ANSWERED_AT_ONCE);
        for (const each of answered) {
          const outcome = yield* answer(tx, tenant, each, review, reviewedAt);
          yield* audit.record(tx, {
            actor: userActor(tenant),
            organizationId,
            action: "card_purchase.reviewed",
            entity: { type: "card_purchase", id: each.id },
            before: {
              reviewState: each.reviewState,
              recurringItemId: each.recurringItemId,
            },
            after: {
              ...review,
              merchantKey,
              outcome,
              ...(outcome === "bill_stays_paid" && { billId: each.billId }),
              ...(each.id !== purchase.id && { answeredWith: purchase.id }),
            },
          });
          if (outcome === "one_off" || outcome === "kept_card_expense") {
            yield* askForReceipt(tx, each);
          }
        }
      }),
    );
    return yield* getCardPurchase(tenant, purchaseId);
  });
}
