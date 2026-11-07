import { Effect } from "effect";

import type {
  LargestPayment,
  OverviewHeading,
  OverviewPayment,
  ReportSpending,
  SpendingMonth,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import { withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { shiftMonth } from "../export/month.js";
import { readPeople } from "./overview.js";
import { readSpendingPayments } from "./payments.js";

/**
 * Money out by month for the reports charts (spec §6.11, §6.24). Every
 * figure comes from the spending overview's own payments
 * (`readSpendingPayments`), so a month here always equals that month on
 * the overview.
 */

const LARGEST_PER_CATEGORY = 5;

interface Tally {
  totalKes: bigint;
  payments: number;
  headings: Record<OverviewHeading, bigint>;
}

const emptyTally = (): Tally => ({
  totalKes: 0n,
  payments: 0,
  headings: {
    petty_cash: 0n,
    transactions: 0n,
    salaries: 0n,
    subscriptions: 0n,
  },
});

function count(tally: Tally, payment: OverviewPayment): void {
  const amount = BigInt(payment.amountKes);
  tally.totalKes += amount;
  tally.payments += 1;
  tally.headings[payment.heading] += amount;
}

const serialise = (month: string, tally: Tally): SpendingMonth => ({
  month,
  totalKes: tally.totalKes.toString(),
  payments: tally.payments,
  headings: {
    petty_cash: tally.headings.petty_cash.toString(),
    transactions: tally.headings.transactions.toString(),
    salaries: tally.headings.salaries.toString(),
    subscriptions: tally.headings.subscriptions.toString(),
  },
});

/** `count` months ending with `last`, and the month before them, oldest first. */
export function monthsEnding(last: string, count: number): string[] {
  return Array.from({ length: count + 1 }, (_, index) =>
    shiftMonth(last, index - count),
  );
}

/** Totals by month, overall and per category, for `months` (oldest first). */
export function spendingByMonth(
  payments: readonly OverviewPayment[],
  months: readonly string[],
): Pick<ReportSpending, "months" | "categories"> {
  const totals = new Map(months.map((month) => [month, emptyTally()]));
  const categories = new Map<
    string,
    { name: string; tallies: Map<string, Tally> }
  >();
  for (const payment of payments) {
    const month = payment.date.slice(0, 7);
    const total = totals.get(month);
    if (!total) continue;
    count(total, payment);
    const category = categories.get(payment.categoryId) ?? {
      name: payment.categoryName,
      tallies: new Map(months.map((each) => [each, emptyTally()])),
    };
    categories.set(payment.categoryId, category);
    const tally = category.tallies.get(month);
    if (tally) count(tally, payment);
  }
  return {
    months: months.map((month) =>
      serialise(month, totals.get(month) ?? emptyTally()),
    ),
    categories: [...categories.entries()]
      .sort(
        ([idA, a], [idB, b]) =>
          a.name.localeCompare(b.name) || idA.localeCompare(idB),
      )
      .map(([id, { name, tallies }]) => ({
        id,
        name,
        months: months.map((month) =>
          serialise(month, tallies.get(month) ?? emptyTally()),
        ),
      })),
  };
}

function largestFirst(a: OverviewPayment, b: OverviewPayment): number {
  const difference = BigInt(b.amountKes) - BigInt(a.amountKes);
  if (difference !== 0n) return difference > 0n ? 1 : -1;
  return b.date.localeCompare(a.date) || a.id.localeCompare(b.id);
}

/** Each category's largest payments in `month`, largest first. */
export function largestPayments(
  payments: readonly OverviewPayment[],
  month: string,
  names: ReadonlyMap<string, string>,
): LargestPayment[] {
  const byCategory = new Map<string, OverviewPayment[]>();
  for (const payment of payments) {
    if (payment.date.slice(0, 7) !== month) continue;
    byCategory.set(payment.categoryId, [
      ...(byCategory.get(payment.categoryId) ?? []),
      payment,
    ]);
  }
  return [...byCategory.values()].flatMap((rows) =>
    rows
      .sort(largestFirst)
      .slice(0, LARGEST_PER_CATEGORY)
      .map((payment) => ({
        id: payment.id,
        subjectId: payment.subjectId,
        kind: payment.kind,
        name: payment.name,
        date: payment.date,
        amountKes: payment.amountKes,
        categoryId: payment.categoryId,
        personName:
          payment.personId === null
            ? null
            : (names.get(payment.personId) ?? null),
      })),
  );
}

export interface ReportSpendingOptions {
  /** `YYYY-MM`; this Nairobi month when left out. */
  readonly month?: string | undefined;
  /** How many months to show, ending with `month`. */
  readonly months: number;
}

export function getReportSpending(
  tenant: Tenant,
  options: ReportSpendingOptions,
  now: Date = new Date(),
): Effect.Effect<ReportSpending, DatabaseError, DatabaseService> {
  const today = nairobiDate(now);
  const month = options.month ?? today.slice(0, 7);
  const months = monthsEnding(month, options.months);
  const first = months[0] ?? month;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const payments = yield* readSpendingPayments(tx, tenant.organizationId, {
        from: `${first}-01`,
        until: `${shiftMonth(month, 1)}-01`,
      });
      const people = yield* readPeople(tx, tenant.organizationId, {
        current: false,
      });
      const names = new Map(people.map(({ id, name }) => [id, name]));
      return {
        month,
        today,
        ...spendingByMonth(payments, months),
        largestPayments: largestPayments(payments, month, names),
      };
    }),
  );
}
