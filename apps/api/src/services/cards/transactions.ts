import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  CardPurchaseKind,
  CardPurchaseStatus,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CardPurchase } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { LithicTransaction } from "../lithic/lithic-client.js";
import type { PaycrestError } from "../paycrest/paycrest-client.js";
import {
  cardPrograms,
  cardPurchases,
  cards,
  categories,
  expenses,
  receiptFiles,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate } from "../bills/status.js";
import { etimsStatusFor } from "../expenses/etims.js";
import { notify } from "../notification/notify.js";
import { kesCentsFromUsdCents } from "../paycrest/amounts.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { enqueueRecordedSpending } from "../zoho/enqueue.js";
import {
  isCardBalanceLow,
  lockCardProgram,
  readCardBalance,
} from "./balance.js";

/**
 * Applies one Lithic transaction, always freshly fetched from Lithic, to its
 * Card purchase (spec §6.25). Both the signed webhook and the reconcile job
 * end here, so it's safe to apply the same state any number of times: the
 * purchase is simply brought in line with what Lithic says now, and the
 * Card expense is recorded at most once, when the money has really left.
 */

const ACTOR = { type: "system", id: "lithic-sync" } as const;

/** Paycrest's marginal rate, as every other USD valuation asks for it. */
const RATE_PROBE_USDC = "1";

export interface CardRef extends Record<string, unknown> {
  readonly card_id: string;
  readonly organization_id: string;
}

/** Which company a card belongs to, found across companies. */
export function cardByLithicToken(
  cardToken: string,
): Effect.Effect<CardRef | null, DatabaseError, DatabaseService> {
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<CardRef>(
        sql`SELECT card_id, organization_id FROM card_by_lithic_token(${cardToken})`,
      ),
    ),
  ).pipe(Effect.map(({ rows }) => rows[0] ?? null));
}

export const companyScope = (organizationId: string) =>
  ({ organizationId, role: "admin" }) as const;

const STATUSES: Readonly<Record<string, CardPurchaseStatus>> = {
  PENDING: "pending",
  SETTLED: "settled",
  VOIDED: "voided",
  EXPIRED: "expired",
  DECLINED: "declined",
};

const NOT_ENOUGH = "There isn't enough in the Card balance.";
const OVER_LIMIT = "It's over this card's monthly limit.";
const OVER_ACCOUNT_LIMIT = "It's over the spending limit for this account.";
const NOT_ALLOWED_HERE = "This merchant isn't allowed on this card.";
const CASH_AND_GAMBLING =
  "Cash and gambling purchases aren't allowed on Expendi cards.";
const TRY_AGAIN = "The card system couldn't confirm it in time. Try again.";

/** Lithic's `detailed_results`, then its `result`, in plain English. */
const DECLINE_REASONS: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: NOT_ENOUGH,
  INSUFFICIENT_FUNDING_SOURCE_BALANCE: NOT_ENOUGH,
  CARD_SPEND_LIMIT_EXCEEDED: OVER_LIMIT,
  PROGRAM_CARD_SPEND_LIMIT_EXCEEDED: OVER_LIMIT,
  ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED: OVER_ACCOUNT_LIMIT,
  ACCOUNT_MONTHLY_SPEND_LIMIT_EXCEEDED: OVER_ACCOUNT_LIMIT,
  ACCOUNT_LIFETIME_SPEND_LIMIT_EXCEEDED: OVER_ACCOUNT_LIMIT,
  CARD_PAUSED: "This card is frozen.",
  CARD_CLOSED: "This card is closed.",
  CARD_EXPIRED: "This card has expired.",
  CARD_SECURITY_CODE_INCORRECT: "The security code was wrong.",
  CARD_EXPIRY_DATE_INCORRECT: "The expiry date was wrong.",
  CARD_PIN_INCORRECT: "The PIN was wrong.",
  ADDRESS_INCORRECT: "The billing address didn't match.",
  UNAUTHORIZED_MERCHANT: NOT_ALLOWED_HERE,
  MERCHANT_NOT_PERMITTED: NOT_ALLOWED_HERE,
  AUTH_RULE_BLOCKED_MCC: NOT_ALLOWED_HERE,
  AUTH_RULE_BLOCKED_COUNTRY: NOT_ALLOWED_HERE,
  PROGRAM_USAGE_RESTRICTION: CASH_AND_GAMBLING,
  SUSPECTED_FRAUD: "It was stopped as possible fraud.",
  CUSTOMER_ASA_TIMEOUT: TRY_AGAIN,
  MALFORMED_ASA_RESPONSE: TRY_AGAIN,
  LITHIC_SYSTEM_ERROR: TRY_AGAIN,
  LITHIC_SYSTEM_RATE_LIMIT: TRY_AGAIN,
};

function declineReasonOf(transaction: LithicTransaction): string | null {
  const codes = [
    ...[...transaction.events]
      .reverse()
      .flatMap((event) => event.detailed_results ?? []),
    transaction.result,
  ];
  for (const code of codes) {
    const reason = DECLINE_REASONS[code];
    if (reason) return reason;
  }
  return null;
}

/** The descriptor Lithic sends, or a stand-in when it's blank. */
export function merchantNameOf(descriptor: string | null | undefined): string {
  const name = descriptor?.trim() ?? "";
  return name === "" ? "Unknown merchant" : name;
}

/** The day the money left: the latest clearing, in Nairobi. */
const SETTLING_EVENTS: ReadonlySet<string> = new Set([
  "CLEARING",
  "FINANCIAL_AUTHORIZATION",
]);

function settlementDate(transaction: LithicTransaction): string {
  const settledAt = [...transaction.events].reverse().flatMap((event) => {
    const created = typeof event.created === "string" ? event.created : null;
    return created !== null && SETTLING_EVENTS.has(event.type) ? [created] : [];
  })[0];
  return nairobiDate(new Date(settledAt ?? transaction.created));
}

/**
 * A credit still on its way: the merchant promised a refund, but only its
 * settlement counts, and nothing should ask for a receipt until then.
 */
const isPendingCredit = (transaction: LithicTransaction): boolean =>
  transaction.amounts.hold.amount > 0 &&
  transaction.amounts.settlement.amount === 0;

interface PurchaseFacts {
  readonly kind: CardPurchaseKind;
  readonly status: CardPurchaseStatus;
  readonly holdUsdCents: bigint;
  readonly settledUsdCents: bigint;
  readonly merchant: string;
  readonly mcc: string;
  readonly merchantCity: string | null;
  readonly merchantCountry: string | null;
  readonly declineReason: string | null;
}

/** A decline never moved money, whatever amounts it arrives with. */
function factsOf(
  transaction: LithicTransaction,
  existing: Pick<CardPurchase, "kind" | "expenseId"> | null,
): PurchaseFacts {
  const declined = transaction.status === "DECLINED";
  const settlement = declined ? 0 : transaction.amounts.settlement.amount;
  const hold = declined ? 0 : transaction.amounts.hold.amount;
  // A purchase with a Card expense stays one; the books aren't adjusted.
  const hasExpense = existing !== null && existing.expenseId !== null;
  const kind: CardPurchaseKind =
    !hasExpense && (existing?.kind === "refund" || settlement > 0)
      ? "refund"
      : "purchase";
  return {
    kind,
    status:
      kind === "refund"
        ? "settled"
        : (STATUSES[transaction.status] ?? "pending"),
    holdUsdCents: BigInt(Math.abs(hold)),
    settledUsdCents: BigInt(Math.abs(settlement)),
    merchant: merchantNameOf(transaction.merchant.descriptor),
    mcc: transaction.merchant.mcc,
    merchantCity: transaction.merchant.city ?? null,
    merchantCountry: transaction.merchant.country ?? null,
    declineReason: declined ? declineReasonOf(transaction) : null,
  };
}

/** A transaction with no money in it is only worth a row when it's a decline. */
const worthARow = (facts: PurchaseFacts): boolean =>
  facts.status === "declined" ||
  facts.holdUsdCents > 0n ||
  facts.settledUsdCents > 0n;

/**
 * A Card expense is owed only once the money has left and nothing is still
 * held: a $7 clearing of a $10 hold is already SETTLED with $3 on hold.
 */
export const owesExpense = (
  purchase: Pick<
    CardPurchase,
    "kind" | "status" | "holdUsdCents" | "settledUsdCents" | "expenseId"
  >,
): boolean =>
  purchase.kind === "purchase" &&
  purchase.status === "settled" &&
  purchase.holdUsdCents === 0n &&
  purchase.settledUsdCents > 0n &&
  purchase.expenseId === null;

function purchaseReceiptCount(
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

/** Under the program lock, so a check against the Card balance waits for this. */
function upsertPurchase(
  tx: Transaction,
  ref: CardRef,
  transaction: LithicTransaction,
): Effect.Effect<CardPurchase | null, DatabaseError> {
  const { organization_id: organizationId, card_id: cardId } = ref;
  return Effect.gen(function* () {
    if (!(yield* lockCardProgram(tx, organizationId))) {
      return yield* Effect.dieMessage(`card ${cardId} has no card program`);
    }
    const [existing] = yield* query(() =>
      tx
        .select()
        .from(cardPurchases)
        .where(eq(cardPurchases.lithicTransactionToken, transaction.token))
        .limit(1),
    );
    const facts = factsOf(transaction, existing ?? null);

    let saved: CardPurchase;
    let moved: boolean;
    if (existing) {
      const amountsMoved =
        existing.holdUsdCents !== facts.holdUsdCents ||
        existing.settledUsdCents !== facts.settledUsdCents;
      moved = amountsMoved;
      if (
        !amountsMoved &&
        existing.status === facts.status &&
        existing.kind === facts.kind &&
        existing.declineReason === facts.declineReason
      ) {
        saved = existing;
      } else {
        const [updated] = yield* query(() =>
          tx
            .update(cardPurchases)
            .set({
              ...facts,
              ...(amountsMoved &&
                existing.expenseId !== null &&
                existing.changedAfterExpenseAt === null && {
                  changedAfterExpenseAt: new Date(),
                }),
            })
            .where(eq(cardPurchases.id, existing.id))
            .returning(),
        );
        if (!updated) return yield* Effect.dieMessage("update wrote no row");
        saved = updated;
      }
    } else {
      if (!worthARow(facts)) return null;
      const [card] = yield* query(() =>
        tx
          .select({
            membershipId: cards.membershipId,
            defaultCategoryId: cards.defaultCategoryId,
          })
          .from(cards)
          .where(
            and(eq(cards.id, cardId), eq(cards.organizationId, organizationId)),
          )
          .limit(1),
      );
      if (!card) return yield* Effect.dieMessage(`card ${cardId} vanished`);
      const [inserted] = yield* query(() =>
        tx
          .insert(cardPurchases)
          .values({
            organizationId,
            cardId,
            membershipId: card.membershipId,
            lithicTransactionToken: transaction.token,
            authorizedAt: new Date(transaction.created),
            categoryId: card.defaultCategoryId,
            ...facts,
          })
          .returning(),
      );
      if (!inserted) return yield* Effect.dieMessage("insert wrote no row");
      saved = inserted;
      moved = facts.holdUsdCents > 0n || facts.settledUsdCents > 0n;
    }

    const event = { organizationId, purchaseId: saved.id };
    const approvedSpend =
      facts.kind === "purchase" &&
      (facts.status === "pending" || facts.status === "settled") &&
      facts.holdUsdCents + facts.settledUsdCents > 0n;
    // Also fires for a row the authorization path inserted; the outbox's
    // dedupe key keeps it to once however many deliveries reach here.
    if (
      approvedSpend &&
      (yield* purchaseReceiptCount(tx, organizationId, saved.id)) === 0
    ) {
      yield* notify(tx, { kind: "card_receipt_needed", ...event });
    }
    if (facts.status === "declined" && existing?.status !== "declined") {
      yield* notify(tx, { kind: "card_purchase_declined", ...event });
    }
    if (facts.kind === "refund" && existing?.kind !== "refund") {
      yield* notify(tx, { kind: "card_refund_received", ...event });
    }
    if (moved) {
      const totals = yield* readCardBalance(tx, organizationId);
      if (isCardBalanceLow(totals)) {
        yield* notify(tx, {
          kind: "card_balance_low",
          organizationId,
          today: nairobiDate(new Date()),
          availableUsdCents: totals.available,
        });
      }
    }
    return saved;
  });
}

/**
 * Records the Card expense, in the one transaction that also stamps the
 * purchase and hands it its receipts. Re-checks under the purchase's row
 * lock, so a concurrent apply finds the expense already made and stops.
 */
function recordCardExpense(
  tx: Transaction,
  organizationId: string,
  purchaseId: string,
  transaction: LithicTransaction,
  rate: string,
): Effect.Effect<boolean, DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const [purchase] = yield* query(() =>
      tx
        .select()
        .from(cardPurchases)
        .where(
          and(
            eq(cardPurchases.id, purchaseId),
            eq(cardPurchases.organizationId, organizationId),
          ),
        )
        .for("update"),
    );
    if (!purchase || !owesExpense(purchase)) return false;
    const [details] = yield* query(() =>
      tx
        .select({
          nickname: cards.nickname,
          lastFour: cards.lastFour,
          paidFromAccountId: cardPrograms.paidFromAccountId,
          etimsNotRequired: categories.etimsNotRequired,
        })
        .from(cards)
        .innerJoin(
          cardPrograms,
          eq(cardPrograms.organizationId, cards.organizationId),
        )
        .innerJoin(categories, eq(categories.id, purchase.categoryId))
        .where(eq(cards.id, purchase.cardId))
        .limit(1),
    );
    if (!details) {
      return yield* Effect.dieMessage(
        `purchase ${purchaseId}: its card, program or category vanished`,
      );
    }
    const values = {
      kind: "card" as const,
      status: "recorded" as const,
      source: "app" as const,
      overviewHeading: "transactions" as const,
      membershipId: purchase.membershipId,
      paidFromAccountId: details.paidFromAccountId,
      merchant: purchase.merchant,
      spentOn: settlementDate(transaction),
      amountKes: kesCentsFromUsdCents(purchase.settledUsdCents, rate),
      categoryId: purchase.categoryId,
      description: `Expendi card ${details.nickname}, ending ${details.lastFour}`,
      etimsStatus: etimsStatusFor(null, details),
    };
    const [expense] = yield* query(() =>
      tx
        .insert(expenses)
        .values({ organizationId, ...values })
        .returning({ id: expenses.id }),
    );
    if (!expense)
      return yield* Effect.dieMessage("expense insert wrote no row");
    yield* query(() =>
      tx
        .update(cardPurchases)
        .set({ expenseId: expense.id, usdKesRate: rate })
        .where(eq(cardPurchases.id, purchase.id)),
    );
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
    if (receipts.length > 0) {
      yield* enqueueRecordedSpending(tx, organizationId, expense.id);
    }
    return true;
  });
}

export type CardTransactionOutcome =
  | {
      readonly applied: false;
      readonly reason: "unknown_card" | "pending_credit" | "no_money";
    }
  | {
      readonly applied: true;
      readonly purchaseId: string;
      readonly expenseRecorded: boolean;
    };

/**
 * Brings a purchase in line with Lithic. A rate failure propagates: the
 * webhook then answers 500 and Lithic retries, or reconcile finds the
 * settled purchase with no expense.
 */
export function applyCardTransaction(
  transaction: LithicTransaction,
): Effect.Effect<
  CardTransactionOutcome,
  DatabaseError | PaycrestError,
  DatabaseService | Paycrest | AuditLog
> {
  return Effect.gen(function* () {
    if (isPendingCredit(transaction)) {
      return { applied: false, reason: "pending_credit" } as const;
    }
    const ref = yield* cardByLithicToken(transaction.card_token);
    if (!ref) return { applied: false, reason: "unknown_card" } as const;
    const scope = companyScope(ref.organization_id);

    const purchase = yield* withScope(scope, (tx) =>
      upsertPurchase(tx, ref, transaction),
    );
    if (!purchase) return { applied: false, reason: "no_money" } as const;
    if (!owesExpense(purchase)) {
      return {
        applied: true,
        purchaseId: purchase.id,
        expenseRecorded: false,
      } as const;
    }

    const paycrest = yield* Paycrest;
    const { rate } = yield* paycrest.rate(RATE_PROBE_USDC);
    const expenseRecorded = yield* withScope(scope, (tx) =>
      recordCardExpense(
        tx,
        ref.organization_id,
        purchase.id,
        transaction,
        rate,
      ),
    );
    return { applied: true, purchaseId: purchase.id, expenseRecorded } as const;
  });
}
