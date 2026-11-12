import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  OverviewHeading,
  RecurringSchedule,
} from "@expendi-business/shared";
import { UNPAID_BILL_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  bills,
  payees,
  payouts,
  recurringItems,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { scheduledStatus } from "../bills/status.js";
import { kesCentsFor } from "../paycrest/amounts.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
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
 * - USD bills at Paycrest's rate now: they haven't been paid yet.
 *
 * Bills being paid are left out: their USDC is already reserved, and the
 * balance compared is the ledger less those reservations. Bills paid outside
 * Expendi are listed but don't count against the wallet. Paycrest's fees and
 * the round-up to whole shillings aren't predicted.
 */

export type CashCheckStatus = "covered" | "short" | "unknown";

export type CashObligationKind = "bill" | "payroll" | "forecast";

export type CashObligationStatus =
  "upcoming" | "due" | "overdue" | "payout_failed" | "forecast";

export type CashPayVia = "expendi" | "outside";

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
   * variable bill) or is in USD and Paycrest's rate is unavailable.
   */
  readonly amountKes: bigint | null;
  readonly payVia: CashPayVia;
  /** A variable amount still to be entered before it can be paid. */
  readonly needsAmount: boolean;
}

export interface CashCheck {
  /** The Nairobi day the window starts. */
  readonly today: string;
  /** The window's last day, included. */
  readonly through: string;
  /** Paycrest's KES per USDC now; null when Paycrest couldn't be reached. */
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

/** Paycrest's marginal sell rate, which is what a small payout gets. */
const RATE_PROBE_USDC = "1";

const DAY_MS = 86_400_000;

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Paycrest's KES rate now, or null when Paycrest can't be reached, so an
 * outage shows the cash check as unknown instead of failing the screen.
 */
export const liveKesRate: Effect.Effect<string | null, never, Paycrest> =
  Effect.flatMap(Paycrest, (paycrest) => paycrest.rate(RATE_PROBE_USDC)).pipe(
    Effect.map(({ rate }) => rate),
    Effect.catchTag("PaycrestError", (error) =>
      Effect.sync(() => {
        console.warn("[cash-check] KES rate unavailable", error.message);
        return null;
      }),
    ),
  );

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
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
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
        nextDueOn: recurringItems.nextDueOn,
      })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
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

const payViaOf = (
  payeeMethod: string | null,
  recurringPayVia: CashPayVia | null,
): CashPayVia =>
  payeeMethod === "outside" || recurringPayVia === "outside"
    ? "outside"
    : "expendi";

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
 * `rate` is Paycrest's KES rate (`liveKesRate`), asked for before the
 * transaction so no connection waits on Paycrest.
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
        payVia: payViaOf(bill.payeeMethod, bill.recurringPayVia),
        needsAmount: bill.amountKes === null && bill.amountUsdc === null,
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
          payVia: payViaOf(item.payeeMethod, item.payVia),
          needsAmount: item.amountKes === null && item.amountUsdc === null,
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
): Effect.Effect<CashCheck, DatabaseError, DatabaseService | Paycrest> {
  return Effect.gen(function* () {
    const rate = yield* liveKesRate;
    return yield* withScope(
      { organizationId: window.organizationId, role: "accountant" },
      (tx) => readCashCheck(tx, window, rate),
    );
  });
}
