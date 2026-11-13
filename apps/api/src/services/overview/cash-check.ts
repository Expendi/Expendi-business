import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  OverviewHeading,
  RecurringPayVia,
  RecurringSchedule,
} from "@expendi-business/shared";
import {
  CARD_BILL_MATCH_WINDOW_DAYS,
  UNPAID_BILL_STATUSES,
  USDC_UNITS_PER_US_CENT,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import {
  bills,
  cardPrograms,
  cardPurchases,
  cards,
  payees,
  payouts,
  recurringItems,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { scheduledStatus } from "../bills/status.js";
import { readCardBalance } from "../cards/balance.js";
import { activeKesRateOrNull } from "../cash-out/active-rate.js";
import { kesCentsFor } from "../paycrest/amounts.js";
import { dueAfter, dueOnOrAfter } from "../recurring/schedule.js";
import {
  ledgerBalance,
  reservedForPayouts,
  reservedForTreasury,
} from "../wallet/ledger.js";

/**
 * The cash check (spec §6.24): the company's spendable USDC, valued in KES,
 * against what the wallet has to pay from today through `days` days ahead.
 * The overview uses 30 days and the wallet-short reminder 7 (spec §6.10).
 *
 * What counts:
 *
 * - Unpaid bills (upcoming, due, overdue, failed) due by the window's end,
 *   overdue ones included, less any salary parts already paid.
 * - Each payroll run as one obligation: its unpaid salary bills.
 * - Due dates no bill exists for yet, from each active recurring payment's
 *   `next_due_on`: a weekly bill's later weeks, and salaries before the
 *   payroll run is drafted 5 days ahead.
 * - USD bills at the active cash-out provider's rate now: they haven't
 *   been paid yet.
 *
 * Bills being paid are left out: their USDC is already reserved, and the
 * balance compared is the ledger less those reservations. Bills paid outside
 * Expendi are listed but don't count against the wallet. Cash-out fees and
 * the round-up to whole shillings aren't predicted.
 *
 * Bills a company-held card pays, and its recurring payments' forecasts,
 * are listed too but count against the Card balance instead, in US cents:
 * their USD estimates, those without one left out, less what a Card
 * purchase meant for the bill has already taken from it (spec §6.20).
 */

export type CashCheckStatus = "covered" | "short" | "unknown";

export type CashObligationKind = "bill" | "payroll" | "forecast";

export type CashObligationStatus =
  "upcoming" | "due" | "overdue" | "payout_failed" | "forecast";

export type CashPayVia = "expendi" | "outside" | "card";

/** The company-held card that pays a bill or a recurring payment. */
export interface CashCard {
  readonly id: string;
  readonly nickname: string;
  readonly lastFour: string;
}

export interface CashObligationView {
  readonly kind: CashObligationKind;
  /** The bill, the payroll run, or (a forecast) the recurring payment. */
  readonly id: string;
  readonly name: string;
  /** The bill's note. */
  readonly notes: string | null;
  /** How often its recurring payment or salary repeats. */
  readonly schedule: RecurringSchedule | null;
  /** A payroll run's payments still to pay. */
  readonly people: number | null;
  readonly heading: OverviewHeading;
  readonly dueOn: string;
  readonly status: CashObligationStatus;
  /**
   * KES cents still to pay. Null when the amount isn't entered yet (a
   * variable bill) or is in USD and the cash-out rate is unavailable.
   */
  readonly amountKes: bigint | null;
  readonly payVia: CashPayVia;
  /** Exactly when `payVia` is `card`. */
  readonly card: CashCard | null;
  /**
   * A card-paid one's estimate in US cents, rounded up; null without one,
   * and for anything else.
   */
  readonly amountUsdCents: bigint | null;
  /** A variable amount still to be entered before it can be paid. */
  readonly needsAmount: boolean;
}

/**
 * The card-paid bills and forecasts due in the window, against the Card
 * balance (`readCardBalance`).
 */
export interface CashCardBills {
  /** Their estimates, US cents; those without one aren't counted. */
  readonly dueUsdCents: bigint;
  /** Negative when purchases ran past what was loaded. */
  readonly availableUsdCents: bigint;
  /** `dueUsdCents` is more than `availableUsdCents`. */
  readonly short: boolean;
}

export interface CashCheck {
  /** The Nairobi day the window starts. */
  readonly today: string;
  /** The window's last day, included. */
  readonly through: string;
  /** The active cash-out provider's KES per USDC now; null when it couldn't be reached. */
  readonly rate: string | null;
  /** The ledger balance, USDC base units. */
  readonly balanceUsdc: bigint;
  /**
   * USDC promised to approved payouts, and to an open move to Treasury, not
   * yet debited.
   */
  readonly reservedUsdc: bigint;
  readonly balanceKes: bigint | null;
  /** The balance less reservations, in KES cents: what's compared. */
  readonly availableKes: bigint | null;
  /** What the wallet has to pay in the window, KES cents, known amounts only. */
  readonly totalKes: bigint;
  /** Due in the window but paid outside Expendi, KES cents. */
  readonly outsideKes: bigint;
  /** Wallet payments in the window without a known amount; not in `totalKes`. */
  readonly unknownAmounts: number;
  /**
   * Null when no company-held card pays anything due in the window, or the
   * company hasn't turned cards on.
   */
  readonly cardBills: CashCardBills | null;
  /**
   * `covered` when `totalKes` fits in `availableKes`, `short` when it
   * doesn't, `unknown` when there's something to pay but no rate to value
   * the balance with.
   */
  readonly status: CashCheckStatus;
  /** KES cents: 0 when covered, null when unknown. */
  readonly shortKes: bigint | null;
  /** Date order, so overdue ones come first. */
  readonly obligations: readonly CashObligationView[];
}

export interface CashCheckWindow {
  readonly organizationId: string;
  /** A Nairobi calendar day, `YYYY-MM-DD` (`nairobiDate`). */
  readonly today: string;
  /** Days after `today` the window runs to, inclusive. */
  readonly days: number;
}

const DAY_MS = 86_400_000;

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function valueInKes(
  amount: {
    readonly currency: "kes" | "usd";
    readonly amountKes: bigint | null;
    readonly amountUsdc: bigint | null;
  },
  rate: string | null,
): bigint | null {
  if (amount.currency === "kes") return amount.amountKes;
  return amount.amountUsdc === null || rate === null
    ? null
    : kesCentsFor(amount.amountUsdc, rate);
}

/** US cents for USDC base units, rounded up so an estimate isn't undercounted. */
const usdCentsFor = (amountUsdc: bigint): bigint =>
  (amountUsdc + USDC_UNITS_PER_US_CENT - 1n) / USDC_UNITS_PER_US_CENT;

const cardColumns = {
  cardId: cards.id,
  cardNickname: cards.nickname,
  cardLastFour: cards.lastFour,
};

const cardOf = (row: {
  readonly cardId: string | null;
  readonly cardNickname: string | null;
  readonly cardLastFour: string | null;
}): CashCard | null =>
  row.cardId === null || row.cardNickname === null || row.cardLastFour === null
    ? null
    : {
        id: row.cardId,
        nickname: row.cardNickname,
        lastFour: row.cardLastFour,
      };

function readUnpaidBills(
  tx: Transaction,
  organizationId: string,
  through: string,
) {
  return query(() =>
    tx
      .select({
        id: bills.id,
        payeeName: payees.name,
        payeeMethod: payees.method,
        recurringPayVia: recurringItems.payVia,
        ...cardColumns,
        recurringSchedule: recurringItems.schedule,
        notes: bills.notes,
        payrollRunId: bills.payrollRunId,
        heading: bills.overviewHeading,
        currency: bills.currency,
        amountKes: bills.amountKes,
        amountUsdc: bills.amountUsdc,
        dueOn: bills.dueOn,
        status: bills.status,
        paidKes: sql<string>`(SELECT coalesce(sum(${payouts.requestedKesCents}), 0)::text FROM ${payouts} WHERE ${payouts.organizationId} = ${bills.organizationId} AND ${payouts.subjectType} = 'bill' AND ${payouts.subjectId} = ${bills.id} AND ${payouts.status} = 'paid')`,
        cardHeldUsdCents: sql<string>`CASE WHEN ${recurringItems.payVia} = 'card' THEN (SELECT coalesce(sum(${cardPurchases.holdUsdCents} + ${cardPurchases.settledUsdCents}), 0) FROM ${cardPurchases} WHERE ${cardPurchases.organizationId} = ${bills.organizationId} AND ${cardPurchases.recurringItemId} = ${bills.recurringItemId} AND ${cardPurchases.billId} IS NULL AND ${cardPurchases.kind} = 'purchase' AND ${cardPurchases.status} IN ('pending', 'settled') AND ${bills.dueOn} <= (${cardPurchases.authorizedAt} AT TIME ZONE 'Africa/Nairobi')::date + ${CARD_BILL_MATCH_WINDOW_DAYS}::int) ELSE 0 END::text`,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
      .leftJoin(cards, eq(cards.id, recurringItems.cardId))
      .where(
        and(
          eq(bills.organizationId, organizationId),
          inArray(bills.status, [...UNPAID_BILL_STATUSES]),
          lte(bills.dueOn, through),
        ),
      ),
  );
}

function readRecurringItems(
  tx: Transaction,
  organizationId: string,
  through: string,
) {
  return query(() =>
    tx
      .select({
        id: recurringItems.id,
        payeeName: payees.name,
        payeeMethod: payees.method,
        heading: recurringItems.overviewHeading,
        currency: recurringItems.currency,
        amountKes: recurringItems.amountKes,
        amountUsdc: recurringItems.amountUsdc,
        schedule: recurringItems.schedule,
        scheduleDay: recurringItems.scheduleDay,
        startsOn: recurringItems.startsOn,
        endsOn: recurringItems.endsOn,
        payVia: recurringItems.payVia,
        ...cardColumns,
        nextDueOn: recurringItems.nextDueOn,
      })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .leftJoin(cards, eq(cards.id, recurringItems.cardId))
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          eq(recurringItems.active, true),
          isNotNull(recurringItems.nextDueOn),
          lte(recurringItems.nextDueOn, through),
        ),
      ),
  );
}

/** Due dates already billed, so a forecast never repeats a bill. */
function readBilledDates(
  tx: Transaction,
  organizationId: string,
  itemIds: readonly string[],
  from: string,
  through: string,
) {
  if (itemIds.length === 0) return Effect.succeed(new Set<string>());
  return query(() =>
    tx
      .select({ itemId: bills.recurringItemId, dueOn: bills.dueOn })
      .from(bills)
      .where(
        and(
          eq(bills.organizationId, organizationId),
          inArray(bills.recurringItemId, [...itemIds]),
          gte(bills.dueOn, from),
          lte(bills.dueOn, through),
        ),
      ),
  ).pipe(
    Effect.map(
      (rows) => new Set(rows.map((row) => `${row.itemId}:${row.dueOn}`)),
    ),
  );
}

function readSpendableUsdc(tx: Transaction, organizationId: string) {
  return Effect.gen(function* () {
    const [wallet] = yield* query(() =>
      tx
        .select({ id: wallets.id })
        .from(wallets)
        .where(
          and(
            eq(wallets.organizationId, organizationId),
            eq(wallets.status, "active"),
          ),
        )
        .limit(1),
    );
    if (!wallet) return { balanceUsdc: 0n, reservedUsdc: 0n };
    return {
      balanceUsdc: yield* ledgerBalance(tx, wallet.id),
      reservedUsdc:
        (yield* reservedForPayouts(tx, wallet.id)) +
        (yield* reservedForTreasury(tx, wallet.id)),
    };
  });
}

/**
 * A company-held card's bills are paid from the Card balance, whoever the
 * payee; the others through Expendi unless the payee or the payment is paid
 * outside it.
 */
const payViaOf = (
  payeeMethod: string | null,
  recurringPayVia: RecurringPayVia | null,
): CashPayVia => {
  if (recurringPayVia === "card") return "card";
  return payeeMethod === "outside" || recurringPayVia === "outside"
    ? "outside"
    : "expendi";
};

/** A card-paid estimate in US cents; null without one, or when not in USD. */
const estimateUsdCents = (amount: {
  readonly currency: "kes" | "usd";
  readonly amountUsdc: bigint | null;
}): bigint | null =>
  amount.currency === "usd" && amount.amountUsdc !== null
    ? usdCentsFor(amount.amountUsdc)
    : null;

/**
 * What the company-held cards have to pay against the Card balance, or
 * null when nothing card-paid is due, or the company hasn't turned cards on.
 * A bill whose own Card purchase is held or settled already, not yet paying
 * it, has that purchase taken off: the Card balance no longer has it, so
 * counting the bill too would count the money twice.
 */
function cardBillsCheck(
  tx: Transaction,
  organizationId: string,
  obligations: readonly CashObligationView[],
  alreadySpent: ReadonlyMap<string, bigint>,
): Effect.Effect<CashCardBills | null, DatabaseError> {
  return Effect.gen(function* () {
    const byCard = obligations.filter(
      (obligation) => obligation.payVia === "card",
    );
    if (byCard.length === 0) return null;
    const [program] = yield* query(() =>
      tx
        .select({ id: cardPrograms.id })
        .from(cardPrograms)
        .where(eq(cardPrograms.organizationId, organizationId))
        .limit(1),
    );
    if (!program) return null;
    const dueUsdCents = byCard.reduce((total, obligation) => {
      const estimate = obligation.amountUsdCents ?? 0n;
      const spent =
        obligation.kind === "bill"
          ? (alreadySpent.get(obligation.id) ?? 0n)
          : 0n;
      return total + (estimate > spent ? estimate - spent : 0n);
    }, 0n);
    const { available } = yield* readCardBalance(tx, organizationId);
    return {
      dueUsdCents,
      availableUsdCents: available,
      short: dueUsdCents > available,
    };
  });
}

/**
 * How a bill or forecast is paid. A card-paid one's estimate is the Card
 * purchase's to settle, so nobody has an amount to enter.
 */
function cardPaid(
  payeeMethod: string | null,
  recurringPayVia: RecurringPayVia | null,
  row: {
    readonly currency: "kes" | "usd";
    readonly amountKes: bigint | null;
    readonly amountUsdc: bigint | null;
    readonly cardId: string | null;
    readonly cardNickname: string | null;
    readonly cardLastFour: string | null;
  },
): Pick<
  CashObligationView,
  "payVia" | "card" | "amountUsdCents" | "needsAmount"
> {
  const payVia = payViaOf(payeeMethod, recurringPayVia);
  if (payVia === "card") {
    return {
      payVia,
      card: cardOf(row),
      amountUsdCents: estimateUsdCents(row),
      needsAmount: false,
    };
  }
  return {
    payVia,
    card: null,
    amountUsdCents: null,
    needsAmount: row.amountKes === null && row.amountUsdc === null,
  };
}

function sumAmounts(amounts: readonly (bigint | null)[]): bigint | null {
  let total = 0n;
  for (const amount of amounts) {
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

/**
 * The cash check inside the caller's transaction, which must be able to
 * read the company's bills and salaries (an admin or accountant scope).
 * `rate` is the active cash-out provider's KES rate
 * (`activeKesRateOrNull`), asked for before the transaction so no
 * connection waits on the provider.
 */
export function readCashCheck(
  tx: Transaction,
  window: CashCheckWindow,
  rate: string | null,
): Effect.Effect<CashCheck, DatabaseError> {
  return Effect.gen(function* () {
    const { organizationId, today, days } = window;
    if (!Number.isInteger(days) || days < 0) {
      return yield* Effect.dieMessage(`cash check window of ${days} days`);
    }
    const through = addDays(today, days);

    const obligations: CashObligationView[] = [];
    const cardSpent = new Map<string, bigint>();
    const payrollRuns = new Map<
      string,
      { dueOn: string; failed: boolean; amounts: (bigint | null)[] }
    >();
    for (const bill of yield* readUnpaidBills(tx, organizationId, through)) {
      const value = valueInKes(bill, rate);
      const paid = BigInt(bill.paidKes);
      const remaining =
        value === null ? null : value > paid ? value - paid : 0n;
      if (bill.payrollRunId !== null) {
        const run = payrollRuns.get(bill.payrollRunId) ?? {
          dueOn: bill.dueOn,
          failed: false,
          amounts: [],
        };
        run.amounts.push(remaining);
        run.failed ||= bill.status === "payout_failed";
        payrollRuns.set(bill.payrollRunId, run);
        continue;
      }
      const cardHeld = BigInt(bill.cardHeldUsdCents);
      if (cardHeld > 0n) cardSpent.set(bill.id, cardHeld);
      obligations.push({
        kind: "bill",
        id: bill.id,
        name: bill.payeeName,
        notes: bill.notes,
        schedule: bill.recurringSchedule,
        people: null,
        heading: bill.heading,
        dueOn: bill.dueOn,
        status:
          bill.status === "payout_failed"
            ? "payout_failed"
            : scheduledStatus(bill.dueOn, today),
        amountKes: remaining,
        ...cardPaid(bill.payeeMethod, bill.recurringPayVia, bill),
      });
    }
    for (const [runId, run] of payrollRuns) {
      obligations.push({
        kind: "payroll",
        id: runId,
        name: "Payroll",
        notes: null,
        schedule: null,
        people: run.amounts.length,
        heading: "salaries",
        dueOn: run.dueOn,
        status: run.failed
          ? "payout_failed"
          : scheduledStatus(run.dueOn, today),
        amountKes: sumAmounts(run.amounts),
        payVia: "expendi",
        card: null,
        amountUsdCents: null,
        needsAmount: false,
      });
    }

    const items = yield* readRecurringItems(tx, organizationId, through);
    const earliest = items.reduce(
      (min, item) =>
        item.nextDueOn !== null && item.nextDueOn < min ? item.nextDueOn : min,
      through,
    );
    const billed = yield* readBilledDates(
      tx,
      organizationId,
      items.map((item) => item.id),
      earliest,
      through,
    );
    for (const item of items) {
      if (item.nextDueOn === null) continue;
      for (
        let dueOn = dueOnOrAfter(item, item.nextDueOn);
        dueOn !== null && dueOn <= through;
        dueOn = dueAfter(item, dueOn)
      ) {
        if (billed.has(`${item.id}:${dueOn}`)) continue;
        obligations.push({
          kind: "forecast",
          id: item.id,
          name: item.payeeName,
          notes: null,
          schedule: item.schedule,
          people: null,
          heading: item.heading,
          dueOn,
          status: "forecast",
          amountKes: valueInKes(item, rate),
          ...cardPaid(item.payeeMethod, item.payVia, item),
        });
      }
    }
    obligations.sort(
      (a, b) =>
        a.dueOn.localeCompare(b.dueOn) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );

    let totalKes = 0n;
    let outsideKes = 0n;
    let unknownAmounts = 0;
    for (const obligation of obligations) {
      if (obligation.payVia === "card") continue;
      if (obligation.payVia === "outside") {
        outsideKes += obligation.amountKes ?? 0n;
      } else if (obligation.amountKes === null) {
        unknownAmounts += 1;
      } else {
        totalKes += obligation.amountKes;
      }
    }

    const { balanceUsdc, reservedUsdc } = yield* readSpendableUsdc(
      tx,
      organizationId,
    );
    const availableUsdc =
      balanceUsdc > reservedUsdc ? balanceUsdc - reservedUsdc : 0n;
    const balanceKes =
      rate === null
        ? null
        : kesCentsFor(balanceUsdc > 0n ? balanceUsdc : 0n, rate);
    const availableKes =
      rate === null ? null : kesCentsFor(availableUsdc, rate);
    const nothingToPay = totalKes === 0n && unknownAmounts === 0;
    const shortKes =
      availableKes === null
        ? nothingToPay
          ? 0n
          : null
        : totalKes > availableKes
          ? totalKes - availableKes
          : 0n;

    return {
      today,
      through,
      rate,
      balanceUsdc,
      reservedUsdc,
      balanceKes,
      availableKes,
      totalKes,
      outsideKes,
      unknownAmounts,
      cardBills: yield* cardBillsCheck(
        tx,
        organizationId,
        obligations,
        cardSpent,
      ),
      status:
        shortKes === null ? "unknown" : shortKes > 0n ? "short" : "covered",
      shortKes,
      obligations,
    };
  });
}

/**
 * The cash check on its own, e.g. from a station job. Reads as a company
 * reader: row-level security then shows it the salaries and bills it sums
 * and lets it write nothing.
 */
export function checkCash(
  window: CashCheckWindow,
): Effect.Effect<
  CashCheck,
  DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const rate = yield* activeKesRateOrNull("cash-check");
    return yield* withScope(
      { organizationId: window.organizationId, role: "accountant" },
      (tx) => readCashCheck(tx, window, rate),
    );
  });
}
