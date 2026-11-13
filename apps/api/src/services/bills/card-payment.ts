import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { BillStatus } from "@expendi-business/shared";
import {
  CARD_BILL_MATCH_WINDOW_DAYS,
  CARD_OVER_ESTIMATE_PERCENT,
  DATED_BILL_STATUSES,
  OUTSTANDING_BILL_STATUSES,
  USDC_UNITS_PER_US_CENT,
} from "@expendi-business/shared";

import type { BillRow, CardPurchase } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  bills,
  cardPurchases,
  categories,
  expenses,
  payees,
  receiptFiles,
  recurringItems,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { cardExpenseSource } from "../cards/card-expense.js";
import { etimsStatusFor } from "../expenses/etims.js";
import { notify } from "../notification/notify.js";
import { kesCentsFromUsdCents } from "../paycrest/amounts.js";
import { onRecurringBillSettled } from "../recurring/next-bill.js";
import { enqueuePaidBill } from "../zoho/enqueue.js";
import { nairobiDate } from "./status.js";

/**
 * A Card purchase on a company-held card pays a bill of the recurring
 * payment its merchant is linked to (spec §6.20):
 *
 * - **Which bill:** the payment's open bill when it's still to be paid and
 *   due no later than a week after the purchase; otherwise an extra bill,
 *   already paid, which leaves the schedule and the open bill alone.
 * - **Paid:** the bill takes the purchase's actual amount and becomes
 *   `paid_by_card`. Its spending row is kind `card` with the bill, in KES
 *   at the day's rate, from the "Expendi cards" account; the bill, not that
 *   row, goes to Zoho, and the next bill is created as usual.
 * - **Declined:** the bill is marked with why, and stays owed.
 *
 * Locks the bill before the recurring payment, as `next-bill.ts` does.
 */

const ACTOR = { type: "system", id: "lithic-sync" } as const;

export const EXTRA_CARD_PURCHASE_NOTE = "Extra card purchase";

const CARD_DECLINED = "The card declined the purchase.";

const STILL_TO_PAY: ReadonlySet<BillStatus> = new Set(DATED_BILL_STATUSES);

interface OpenBill {
  readonly bill: BillRow;
  /** Still to be paid, and due by `CARD_BILL_MATCH_WINDOW_DAYS` after the purchase. */
  readonly meantForPurchase: boolean;
}

function lockOpenBill(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
  purchasedOn: string,
): Effect.Effect<OpenBill | null, DatabaseError> {
  return query(() =>
    tx
      .select({
        bill: bills,
        inWindow: sql<boolean>`${bills.dueOn} <= ${purchasedOn}::date + ${CARD_BILL_MATCH_WINDOW_DAYS}::int`,
      })
      .from(bills)
      .where(
        and(
          eq(bills.organizationId, organizationId),
          eq(bills.recurringItemId, recurringItemId),
          inArray(bills.status, [...OUTSTANDING_BILL_STATUSES]),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.map(([row]) =>
      row
        ? {
            bill: row.bill,
            meantForPurchase: row.inWindow && STILL_TO_PAY.has(row.bill.status),
          }
        : null,
    ),
  );
}

/**
 * A declined purchase matched to a recurring payment marks the bill it was
 * meant for. The status never changes: the bill stays owed and goes
 * overdue as usual. Returns the bill marked, if any.
 */
export function markBillCardDeclined(
  tx: Transaction,
  purchase: CardPurchase,
): Effect.Effect<string | null, DatabaseError, AuditLog> {
  const { organizationId, recurringItemId } = purchase;
  if (recurringItemId === null) return Effect.succeed(null);
  return Effect.gen(function* () {
    const open = yield* lockOpenBill(
      tx,
      organizationId,
      recurringItemId,
      nairobiDate(purchase.authorizedAt),
    );
    if (!open?.meantForPurchase) return null;
    const declined = {
      cardDeclinedAt: new Date(),
      cardDeclineReason: purchase.declineReason ?? CARD_DECLINED,
    };
    yield* query(() =>
      tx.update(bills).set(declined).where(eq(bills.id, open.bill.id)),
    );
    const audit = yield* AuditLog;
    yield* audit.record(tx, {
      actor: ACTOR,
      organizationId,
      action: "bill.card_declined",
      entity: { type: "bill", id: open.bill.id },
      after: { ...declined, cardPurchaseId: purchase.id },
    });
    return open.bill.id;
  });
}

export interface CardBillPayment {
  /** Locked by the caller: settled, with nothing on hold, and matched. */
  readonly purchase: CardPurchase;
  /** The Nairobi day the money left. */
  readonly settledOn: string;
  readonly rate: string;
  /**
   * A Card expense the purchase already recorded before an admin linked its
   * merchant. It becomes the bill's spending row, so the money is counted
   * once.
   */
  readonly cardExpenseId: string | null;
}

export interface PaidByCard {
  readonly billId: string;
  /** Recorded as an extra bill: the open one wasn't the one it paid. */
  readonly extra: boolean;
}

function recurringItemOf(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
) {
  return query(() =>
    tx
      .select({
        payeeId: recurringItems.payeeId,
        payeeName: payees.name,
        overviewHeading: recurringItems.overviewHeading,
        categoryId: recurringItems.categoryId,
        estimateUsdc: recurringItems.amountUsdc,
      })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          eq(recurringItems.id, recurringItemId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([item]) =>
      item
        ? Effect.succeed(item)
        : Effect.dieMessage(`recurring item ${recurringItemId} vanished`),
    ),
  );
}

function etimsFreeCategory(tx: Transaction, categoryId: string) {
  return query(() =>
    tx
      .select({ etimsNotRequired: categories.etimsNotRequired })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1),
  ).pipe(
    Effect.flatMap(([category]) =>
      category
        ? Effect.succeed(category)
        : Effect.dieMessage(`category ${categoryId} vanished`),
    ),
  );
}

/**
 * The bill's spending row: a new one, or the purchase's Card expense moved
 * onto the bill's heading, category and payee. Returns its ID.
 */
function recordBillSpending(
  tx: Transaction,
  payment: CardBillPayment,
  bill: BillRow,
  payeeName: string,
): Effect.Effect<string, DatabaseError, AuditLog> {
  const { purchase, rate } = payment;
  const { organizationId } = purchase;
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const category = yield* etimsFreeCategory(tx, bill.categoryId);
    const onBill = {
      overviewHeading: bill.overviewHeading,
      categoryId: bill.categoryId,
      merchant: payeeName,
      billId: bill.id,
    };

    const { cardExpenseId } = payment;
    if (cardExpenseId !== null) {
      const [before] = yield* query(() =>
        tx
          .select()
          .from(expenses)
          .where(
            and(
              eq(expenses.id, cardExpenseId),
              eq(expenses.organizationId, organizationId),
            ),
          )
          .for("update"),
      );
      if (!before) {
        return yield* Effect.dieMessage(`expense ${cardExpenseId} vanished`);
      }
      const after = {
        ...onBill,
        etimsStatus: etimsStatusFor(before.etimsInvoiceNumber, category),
      };
      yield* query(() =>
        tx.update(expenses).set(after).where(eq(expenses.id, cardExpenseId)),
      );
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: "expense.edited",
        entity: { type: "expense", id: cardExpenseId },
        before: {
          overviewHeading: before.overviewHeading,
          categoryId: before.categoryId,
          merchant: before.merchant,
          billId: before.billId,
          etimsStatus: before.etimsStatus,
        },
        after: { ...after, cardPurchaseId: purchase.id },
      });
      return cardExpenseId;
    }

    const source = yield* cardExpenseSource(tx, purchase);
    const values = {
      kind: "card" as const,
      status: "recorded" as const,
      source: "app" as const,
      membershipId: source.membershipId,
      paidFromAccountId: source.paidFromAccountId,
      spentOn: payment.settledOn,
      amountKes: kesCentsFromUsdCents(purchase.settledUsdCents, rate),
      description: source.description,
      etimsStatus: etimsStatusFor(null, category),
      ...onBill,
    };
    const [expense] = yield* query(() =>
      tx
        .insert(expenses)
        .values({ organizationId, ...values })
        .returning({ id: expenses.id }),
    );
    if (!expense)
      return yield* Effect.dieMessage("expense insert wrote no row");
    const receipts = yield* query(() =>
      tx
        .update(receiptFiles)
        .set({ expenseId: expense.id })
        .where(
          and(
            eq(receiptFiles.organizationId, organizationId),
            eq(receiptFiles.cardPurchaseId, purchase.id),
          ),
        )
        .returning({ id: receiptFiles.id }),
    );
    yield* audit.record(tx, {
      actor: ACTOR,
      organizationId,
      action: "expense.recorded",
      entity: { type: "expense", id: expense.id },
      after: {
        ...values,
        cardPurchaseId: purchase.id,
        usdKesRate: rate,
        receiptFileIds: receipts.map((file) => file.id),
      },
    });
    return expense.id;
  });
}

const overEstimate = (amountUsdc: bigint, estimateUsdc: bigint | null) =>
  estimateUsdc !== null &&
  amountUsdc * 100n > estimateUsdc * BigInt(100 + CARD_OVER_ESTIMATE_PERCENT);

/**
 * Pays the bill with the settled purchase, in the caller's transaction and
 * company scope, which must carry the admin role. The caller holds the
 * purchase's row lock and has checked it isn't recorded yet, so a second
 * apply of the same transaction finds it done and never gets here.
 */
export function payBillByCard(
  tx: Transaction,
  payment: CardBillPayment,
): Effect.Effect<PaidByCard, DatabaseError, AuditLog> {
  const { purchase, settledOn, rate } = payment;
  const { organizationId, recurringItemId } = purchase;
  return Effect.gen(function* () {
    if (recurringItemId === null) {
      return yield* Effect.dieMessage(
        `purchase ${purchase.id} pays no recurring payment`,
      );
    }
    const audit = yield* AuditLog;
    const open = yield* lockOpenBill(
      tx,
      organizationId,
      recurringItemId,
      settledOn,
    );
    const item = yield* recurringItemOf(tx, organizationId, recurringItemId);
    const amountUsdc = purchase.settledUsdCents * USDC_UNITS_PER_US_CENT;
    const paidAt = new Date();
    const paid = {
      status: "paid_by_card" as const,
      currency: "usd" as const,
      amountKes: null,
      amountUsdc,
      variable: false,
      paidOn: settledOn,
      paidAt,
      cardPurchaseId: purchase.id,
      cardDeclinedAt: null,
      cardDeclineReason: null,
    };

    const pays = open?.meantForPurchase === true ? open.bill : null;
    const [bill] = yield* query(() =>
      pays
        ? tx.update(bills).set(paid).where(eq(bills.id, pays.id)).returning()
        : tx
            .insert(bills)
            .values({
              organizationId,
              payeeId: item.payeeId,
              recurringItemId,
              overviewHeading: item.overviewHeading,
              categoryId: item.categoryId,
              dueOn: settledOn,
              notes: EXTRA_CARD_PURCHASE_NOTE,
              ...paid,
            })
            .returning(),
    );
    if (!bill) return yield* Effect.dieMessage("bill write returned no row");

    const expenseId = yield* recordBillSpending(
      tx,
      payment,
      bill,
      item.payeeName,
    );
    yield* query(() =>
      tx
        .update(cardPurchases)
        .set({ billId: bill.id, expenseId, usdKesRate: rate })
        .where(eq(cardPurchases.id, purchase.id)),
    );
    yield* audit.record(tx, {
      actor: ACTOR,
      organizationId,
      action: "bill.paid_by_card",
      entity: { type: "bill", id: bill.id },
      before: pays
        ? {
            status: pays.status,
            currency: pays.currency,
            amountKes: pays.amountKes,
            amountUsdc: pays.amountUsdc,
            variable: pays.variable,
          }
        : null,
      after: {
        status: bill.status,
        amountUsdc,
        paidOn: settledOn,
        cardPurchaseId: purchase.id,
        expenseId,
        usdKesRate: rate,
        extra: pays === null,
      },
    });
    yield* enqueuePaidBill(tx, organizationId, bill.id);
    // An extra bill never held the schedule's place, so this only makes sure
    // the payment still has its next bill, as the daily job would.
    yield* onRecurringBillSettled(tx, bill, paidAt);
    if (overEstimate(amountUsdc, item.estimateUsdc)) {
      yield* notify(tx, {
        kind: "card_purchase_over_estimate",
        organizationId,
        billId: bill.id,
        purchaseId: purchase.id,
      });
    }
    return { billId: bill.id, extra: pays === null };
  });
}
