import type { SQL } from "drizzle-orm";
import type { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  attachCardReceiptRequestSchema,
  CardPurchaseKind,
  CardPurchaseMatchState,
  CardPurchaseStatus,
  listCardPurchasesQuerySchema,
  waiveCardReceiptRequestSchema,
} from "@expendi-business/shared";
import {
  MAX_RECEIPTS_PER_CLAIM,
  readsWholeCompany,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CardPurchase } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { FileStorage } from "../storage/file-storage.js";
import type { CardHolderView } from "./views.js";
import {
  cardPurchases,
  cards,
  categories,
  expenses,
  memberships,
  payees,
  receiptFiles,
  recurringItems,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { etimsStatusFor } from "../expenses/etims.js";
import {
  addCardPurchaseReceipts,
  checkAttachableReceipts,
} from "../expenses/receipts.js";
import { enqueueRecordedSpending } from "../zoho/enqueue.js";
import { cardHolderView } from "./views.js";

/**
 * Card purchases as people read them, and the receipts and waivers that
 * complete a Card expense (spec §6.25). Admins and accountants see every
 * purchase; anyone else only their own, and gets NotFound for the rest.
 */

/** `CardPurchase` before serialisation turns bigints and dates into strings. */
export interface CardPurchaseView {
  readonly id: string;
  readonly kind: CardPurchaseKind;
  readonly status: CardPurchaseStatus;
  readonly card: {
    readonly id: string;
    readonly nickname: string;
    readonly lastFour: string;
  };
  readonly companyHeld: boolean;
  /** Null exactly when the card is company-held. */
  readonly holder: CardHolderView | null;
  readonly yours: boolean;
  readonly merchant: string;
  readonly merchantKey: string | null;
  readonly match: CardPurchaseMatchView | null;
  readonly mcc: string;
  readonly holdUsdCents: bigint;
  readonly settledUsdCents: bigint;
  readonly amountKes: bigint | null;
  readonly usdKesRate: string | null;
  readonly authorizedAt: Date;
  readonly declineReason: string | null;
  readonly expenseId: string | null;
  readonly category: { readonly id: string; readonly name: string };
  readonly receiptCount: number;
  readonly noReceiptReason: string | null;
  readonly needsReceipt: boolean;
  readonly changedAfterExpense: boolean;
}

/** `CardPurchaseMatch`: what a purchase on a company-held card is. */
export interface CardPurchaseMatchView {
  readonly state: CardPurchaseMatchState;
  readonly recurringItemId: string | null;
  readonly billId: string | null;
  readonly payeeName: string | null;
}

export interface CardPurchasesPageView {
  readonly purchases: readonly CardPurchaseView[];
  readonly nextCursor: string | null;
}

const purchaseNotFound = new NotFound({
  message: "That purchase wasn't found.",
});
const badCursor = new BadRequest({ message: "That page link isn't valid." });
const notASpend = new BadRequest({
  message: "A receipt can't go on a declined or voided purchase, or a refund.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});
const categoryLocked = new BadRequest({
  message: "The category can only change with the first receipt or the reason.",
});
const tooManyReceipts = new BadRequest({
  message: `Add at most ${MAX_RECEIPTS_PER_CLAIM} receipts.`,
});
const notSettledYet = new BadRequest({
  message: "You can say there's no receipt once the purchase has settled.",
});
const reasonWithReceipt = new BadRequest({
  message: "Only give a reason when there's no receipt.",
});
const alreadyWaived = new Conflict({
  message: "This purchase already has a reason for its missing receipt.",
});

const receiptCount = sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.cardPurchaseId} = ${cardPurchases.id})`;

/**
 * A spend with no receipt yet and no admin waiver. A purchase that pays, or
 * will pay, a recurring payment's bill never needs one: the bill is the
 * record. Nor does one waiting for an admin's answer about its merchant,
 * since it may yet pay a bill, nor one from a merchant admins didn't
 * recognise, since nobody has its receipt. Needs `expenses` joined.
 */
export const needsReceiptSql = sql<boolean>`(${cardPurchases.kind} = 'purchase' AND ${cardPurchases.status} NOT IN ('declined', 'voided', 'expired') AND ${cardPurchases.recurringItemId} IS NULL AND ${cardPurchases.reviewState} IS DISTINCT FROM 'needs_review' AND ${cardPurchases.reviewState} IS DISTINCT FROM 'not_recognised' AND ${receiptCount} = 0 AND ${expenses.noReceiptReason} IS NULL)`;

const selectPurchases = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select({
      id: cardPurchases.id,
      kind: cardPurchases.kind,
      status: cardPurchases.status,
      cardId: cards.id,
      cardNickname: cards.nickname,
      cardLastFour: cards.lastFour,
      companyHeld: cards.companyHeld,
      membershipId: cardPurchases.membershipId,
      holderName: users.fullName,
      holderEmail: users.email,
      merchant: cardPurchases.merchant,
      merchantKey: cardPurchases.merchantKey,
      recurringItemId: cardPurchases.recurringItemId,
      billId: cardPurchases.billId,
      reviewState: cardPurchases.reviewState,
      payeeName: payees.name,
      mcc: cardPurchases.mcc,
      holdUsdCents: cardPurchases.holdUsdCents,
      settledUsdCents: cardPurchases.settledUsdCents,
      amountKes: expenses.amountKes,
      usdKesRate: cardPurchases.usdKesRate,
      authorizedAt: cardPurchases.authorizedAt,
      declineReason: cardPurchases.declineReason,
      expenseId: cardPurchases.expenseId,
      categoryId: categories.id,
      categoryName: categories.name,
      receiptCount,
      noReceiptReason: expenses.noReceiptReason,
      needsReceipt: needsReceiptSql,
      changedAfterExpenseAt: cardPurchases.changedAfterExpenseAt,
      /** Microsecond precision, so paging never skips or repeats a purchase. */
      cursorAt: sql<string>`to_char(${cardPurchases.authorizedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(cardPurchases)
    .innerJoin(cards, eq(cards.id, cardPurchases.cardId))
    .leftJoin(memberships, eq(memberships.id, cardPurchases.membershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .innerJoin(categories, eq(categories.id, cardPurchases.categoryId))
    .leftJoin(expenses, eq(expenses.id, cardPurchases.expenseId))
    .leftJoin(
      recurringItems,
      eq(recurringItems.id, cardPurchases.recurringItemId),
    )
    .leftJoin(payees, eq(payees.id, recurringItems.payeeId))
    .where(where);

type PurchaseRow = Awaited<ReturnType<typeof selectPurchases>>[number];

/** Null until a company-held card's purchase is matched or flagged. */
function matchOf(row: PurchaseRow): CardPurchaseMatchView | null {
  if (!row.companyHeld) return null;
  const state: CardPurchaseMatchState | null =
    row.recurringItemId !== null ? "matched" : row.reviewState;
  return state === null
    ? null
    : {
        state,
        recurringItemId: row.recurringItemId,
        billId: row.billId,
        payeeName: row.payeeName,
      };
}

function toPurchaseView(tenant: Tenant, row: PurchaseRow): CardPurchaseView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    card: {
      id: row.cardId,
      nickname: row.cardNickname,
      lastFour: row.cardLastFour,
    },
    companyHeld: row.companyHeld,
    holder: cardHolderView(row.membershipId, row.holderName, row.holderEmail),
    yours:
      row.membershipId !== null && row.membershipId === tenant.membershipId,
    merchant: row.merchant,
    merchantKey: row.merchantKey,
    match: matchOf(row),
    mcc: row.mcc,
    holdUsdCents: row.holdUsdCents,
    settledUsdCents: row.settledUsdCents,
    amountKes: row.amountKes,
    usdKesRate: row.usdKesRate,
    authorizedAt: row.authorizedAt,
    declineReason: row.declineReason,
    expenseId: row.expenseId,
    category: { id: row.categoryId, name: row.categoryName },
    receiptCount: row.receiptCount,
    noReceiptReason: row.noReceiptReason,
    needsReceipt: row.needsReceipt,
    changedAfterExpense: row.changedAfterExpenseAt !== null,
  };
}

const visiblePurchases = (tenant: Tenant): SQL | undefined =>
  and(
    eq(cardPurchases.organizationId, tenant.organizationId),
    readsWholeCompany(tenant.role)
      ? undefined
      : eq(cardPurchases.membershipId, tenant.membershipId),
  );

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const encodeCursor = (row: PurchaseRow): string =>
  Buffer.from(`${row.cursorAt}|${row.id}`, "utf8").toString("base64url");

function decodeCursor(
  cursor: string,
): Effect.Effect<{ readonly at: string; readonly id: string }, BadRequest> {
  const match = CURSOR_PATTERN.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  return match?.[1] && match[2]
    ? Effect.succeed({ at: match[1], id: match[2] })
    : Effect.fail(badCursor);
}

/** Newest first, a page at a time. */
export function listCardPurchases(
  tenant: Tenant,
  options: z.output<typeof listCardPurchasesQuerySchema>,
): Effect.Effect<
  CardPurchasesPageView,
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const after =
      options.cursor === undefined ? null : yield* decodeCursor(options.cursor);
    const rows = yield* withScope(tenant, (tx) =>
      query(() =>
        selectPurchases(
          tx,
          and(
            visiblePurchases(tenant),
            options.cardId === undefined
              ? undefined
              : eq(cardPurchases.cardId, options.cardId),
            options.status === undefined
              ? undefined
              : eq(cardPurchases.status, options.status),
            options.mine === true
              ? eq(cardPurchases.membershipId, tenant.membershipId)
              : undefined,
            options.needsReceipt === undefined
              ? undefined
              : options.needsReceipt
                ? needsReceiptSql
                : sql`NOT ${needsReceiptSql}`,
            options.needsReview === undefined
              ? undefined
              : options.needsReview
                ? eq(cardPurchases.reviewState, "needs_review")
                : sql`${cardPurchases.reviewState} IS DISTINCT FROM 'needs_review'`,
            after === null
              ? undefined
              : sql`(${cardPurchases.authorizedAt}, ${cardPurchases.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
          ),
        )
          .orderBy(desc(cardPurchases.authorizedAt), desc(cardPurchases.id))
          .limit(options.limit + 1),
      ),
    );
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      purchases: page.map((row) => toPurchaseView(tenant, row)),
      nextCursor:
        rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  });
}

export function getCardPurchase(
  tenant: Tenant,
  purchaseId: string,
): Effect.Effect<CardPurchaseView, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectPurchases(
        tx,
        and(visiblePurchases(tenant), eq(cardPurchases.id, purchaseId)),
      ).limit(1),
    ).pipe(
      Effect.flatMap(([row]) =>
        row
          ? Effect.succeed(toPurchaseView(tenant, row))
          : Effect.fail(purchaseNotFound),
      ),
    ),
  );
}

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

function lockPurchase(
  tx: Transaction,
  tenant: Tenant,
  purchaseId: string,
): Effect.Effect<CardPurchase, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(cardPurchases)
      .where(and(visiblePurchases(tenant), eq(cardPurchases.id, purchaseId)))
      .for("update"),
  ).pipe(
    Effect.flatMap(([purchase]) =>
      purchase ? Effect.succeed(purchase) : Effect.fail(purchaseNotFound),
    ),
  );
}

interface LinkedExpense {
  readonly noReceiptReason: string | null;
  readonly etimsInvoiceNumber: string | null;
}

function linkedExpense(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
): Effect.Effect<LinkedExpense, DatabaseError> {
  return query(() =>
    tx
      .select({
        noReceiptReason: expenses.noReceiptReason,
        etimsInvoiceNumber: expenses.etimsInvoiceNumber,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.organizationId, organizationId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([expense]) =>
      expense
        ? Effect.succeed(expense)
        : Effect.dieMessage(`expense ${expenseId} vanished`),
    ),
  );
}

function purchaseFileCount(
  tx: Transaction,
  organizationId: string,
  purchaseId: string,
): Effect.Effect<number, DatabaseError> {
  return query(() =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          eq(receiptFiles.cardPurchaseId, purchaseId),
        ),
      ),
  ).pipe(Effect.map(([row]) => row?.count ?? 0));
}

/** Only with the first receipt or the waiver: the Card expense's books. */
function changeCategory(
  tx: Transaction,
  tenant: Tenant,
  purchase: CardPurchase,
  expense: LinkedExpense | null,
  categoryId: string | undefined,
  mayChange: boolean,
): Effect.Effect<void, BadRequest | DatabaseError> {
  if (categoryId === undefined || categoryId === purchase.categoryId) {
    return Effect.void;
  }
  if (!mayChange) return Effect.fail(categoryLocked);
  return Effect.gen(function* () {
    const [category] = yield* query(() =>
      tx
        .select({ etimsNotRequired: categories.etimsNotRequired })
        .from(categories)
        .where(
          and(
            eq(categories.organizationId, tenant.organizationId),
            eq(categories.id, categoryId),
            eq(categories.archived, false),
          ),
        )
        .limit(1),
    );
    if (!category) return yield* Effect.fail(unknownCategory);
    yield* query(() =>
      tx
        .update(cardPurchases)
        .set({ categoryId })
        .where(eq(cardPurchases.id, purchase.id)),
    );
    if (expense !== null && purchase.expenseId !== null) {
      const { expenseId } = purchase;
      yield* query(() =>
        tx
          .update(expenses)
          .set({
            categoryId,
            etimsStatus: etimsStatusFor(expense.etimsInvoiceNumber, category),
          })
          .where(eq(expenses.id, expenseId)),
      );
    }
  });
}

const canHoldReceipts = (
  purchase: Pick<CardPurchase, "kind" | "status">,
): boolean =>
  purchase.kind === "purchase" &&
  (purchase.status === "pending" || purchase.status === "settled");

/**
 * Receipts for a purchase, any time from authorization on. They reach the
 * Card expense when it's recorded, or at once if it already exists, and
 * that's when it's complete and can go to Zoho.
 */
export function attachCardReceipts(
  tenant: Tenant,
  purchaseId: string,
  fields: z.output<typeof attachCardReceiptRequestSchema>,
): Effect.Effect<
  CardPurchaseView,
  BadRequest | Conflict | NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | FileStorage
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const current = yield* getCardPurchase(tenant, purchaseId);
    if (!canHoldReceipts(current)) return yield* Effect.fail(notASpend);
    yield* checkAttachableReceipts(
      tenant,
      fields.receiptFileIds,
      current.expenseId,
      current.id,
    );
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const purchase = yield* lockPurchase(tx, tenant, purchaseId);
        if (!canHoldReceipts(purchase)) return yield* Effect.fail(notASpend);
        const expense =
          purchase.expenseId === null
            ? null
            : yield* linkedExpense(tx, organizationId, purchase.expenseId);
        const before = yield* purchaseFileCount(
          tx,
          organizationId,
          purchase.id,
        );
        yield* changeCategory(
          tx,
          tenant,
          purchase,
          expense,
          fields.categoryId,
          before === 0 && !expense?.noReceiptReason,
        );
        const added = yield* addCardPurchaseReceipts(
          tx,
          tenant,
          purchase,
          fields.receiptFileIds,
        );
        if (added.length === 0) return;
        if (before + added.length > MAX_RECEIPTS_PER_CLAIM) {
          return yield* Effect.fail(tooManyReceipts);
        }
        if (purchase.expenseId !== null) {
          const { expenseId } = purchase;
          if (expense?.noReceiptReason) {
            yield* query(() =>
              tx
                .update(expenses)
                .set({ noReceiptReason: null })
                .where(eq(expenses.id, expenseId)),
            );
          }
          yield* enqueueRecordedSpending(tx, organizationId, expenseId);
        }
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "card_purchase.receipts_added",
          entity: { type: "card_purchase", id: purchase.id },
          after: {
            receiptFileIds: added,
            categoryId: fields.categoryId ?? purchase.categoryId,
          },
        });
      }),
    );
    return yield* getCardPurchase(tenant, purchaseId);
  });
}

/**
 * An admin saying why a settled purchase will never have a receipt, which
 * completes its Card expense for Zoho. Only once the expense exists: until
 * it has settled the purchase can still change or vanish.
 */
export function waiveCardReceipt(
  tenant: Tenant,
  purchaseId: string,
  fields: z.output<typeof waiveCardReceiptRequestSchema>,
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
        const purchase = yield* lockPurchase(tx, tenant, purchaseId);
        if (!canHoldReceipts(purchase) || purchase.expenseId === null) {
          return yield* Effect.fail(
            canHoldReceipts(purchase) ? notSettledYet : notASpend,
          );
        }
        const { expenseId } = purchase;
        const expense = yield* linkedExpense(tx, organizationId, expenseId);
        if (expense.noReceiptReason === fields.reason) return;
        if (expense.noReceiptReason !== null) {
          return yield* Effect.fail(alreadyWaived);
        }
        const before = yield* purchaseFileCount(
          tx,
          organizationId,
          purchase.id,
        );
        if (before > 0) return yield* Effect.fail(reasonWithReceipt);
        yield* changeCategory(
          tx,
          tenant,
          purchase,
          expense,
          fields.categoryId,
          true,
        );
        yield* query(() =>
          tx
            .update(expenses)
            .set({ noReceiptReason: fields.reason })
            .where(eq(expenses.id, expenseId)),
        );
        yield* enqueueRecordedSpending(tx, organizationId, expenseId);
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "card_purchase.receipt_waived",
          entity: { type: "card_purchase", id: purchase.id },
          after: {
            noReceiptReason: fields.reason,
            categoryId: fields.categoryId ?? purchase.categoryId,
          },
        });
      }),
    );
    return yield* getCardPurchase(tenant, purchaseId);
  });
}
