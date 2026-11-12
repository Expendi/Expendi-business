import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  CashObligation,
  OverviewPayment,
  OverviewPerson,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  OVERVIEW_HEADING_LABELS,
  OVERVIEW_HEADINGS,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { CashCheck, CashObligationView } from "./cash-check.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { nairobiDate } from "../bills/status.js";
import { activeKesRateOrNull } from "../cash-out/active-rate.js";
import { listFloats } from "../floats/views.js";
import { readCashCheck } from "./cash-check.js";
import { readSpendingPayments } from "./payments.js";

/**
 * The spending overview (spec §6.24), for admins and, read-only,
 * accountants (spec §4). Every date is a Nairobi calendar day.
 */

const CASH_CHECK_DAYS = 30;
const RECENT_PAYMENTS = 20;
const PERSON_ROWS = 50;

const personNotFound = new NotFound({ message: "Person not found" });

export interface MonthBounds {
  readonly previous: string;
  /** The first day of the previous month. */
  readonly from: string;
  /** The first day of `month`. */
  readonly start: string;
  /** The first day after `month`. */
  readonly until: string;
}

/** `month` is `YYYY-MM`. */
export function monthBounds(month: string): MonthBounds {
  const [year = 0, number = 1] = month.split("-").map(Number);
  const firstOf = (offset: number) =>
    new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 10);
  const from = firstOf(-1);
  return {
    previous: from.slice(0, 7),
    from,
    start: firstOf(0),
    until: firstOf(1),
  };
}

interface Breakdown {
  id: string;
  name: string;
  currentKes: bigint;
  previousKes: bigint;
}

const serialiseBreakdown = (row: Breakdown) => ({
  id: row.id,
  name: row.name,
  currentKes: row.currentKes.toString(),
  previousKes: row.previousKes.toString(),
});

/** Totals by heading and category for `month` and the month before. */
export function spendingBreakdown(
  payments: readonly OverviewPayment[],
  month: string,
): Pick<
  SpendingOverview,
  "currentKes" | "previousKes" | "headings" | "categories"
> {
  const bounds = monthBounds(month);
  const total: Breakdown = {
    id: "total",
    name: "Total",
    currentKes: 0n,
    previousKes: 0n,
  };
  const headings = new Map<string, Breakdown>(
    OVERVIEW_HEADINGS.map((id) => [
      id,
      {
        id,
        name: OVERVIEW_HEADING_LABELS[id],
        currentKes: 0n,
        previousKes: 0n,
      },
    ]),
  );
  const categories = new Map<string, Breakdown>();
  for (const payment of payments) {
    if (payment.date < bounds.from || payment.date >= bounds.until) continue;
    const period = payment.date >= bounds.start ? "currentKes" : "previousKes";
    const amount = BigInt(payment.amountKes);
    const category = categories.get(payment.categoryId) ?? {
      id: payment.categoryId,
      name: payment.categoryName,
      currentKes: 0n,
      previousKes: 0n,
    };
    categories.set(payment.categoryId, category);
    for (const row of [total, headings.get(payment.heading), category]) {
      if (row) row[period] += amount;
    }
  }
  return {
    currentKes: total.currentKes.toString(),
    previousKes: total.previousKes.toString(),
    headings: [...headings.values()].map(serialiseBreakdown),
    categories: [...categories.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map(serialiseBreakdown),
  };
}

const serialiseObligation = (row: CashObligationView): CashObligation => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  notes: row.notes,
  schedule: row.schedule,
  people: row.people,
  dueOn: row.dueOn,
  amountKes: row.amountKes?.toString() ?? null,
  status: row.status,
  payVia: row.payVia,
  needsAmount: row.needsAmount,
  heading: row.heading,
});

function serialiseCash(cash: CashCheck): SpendingOverview["cash"] {
  return {
    today: cash.today,
    through: cash.through,
    totalKes: cash.totalKes.toString(),
    unknownAmounts: cash.unknownAmounts,
    obligations: cash.obligations.map(serialiseObligation),
    balanceUsdc: cash.balanceUsdc.toString(),
    reservedUsdc: cash.reservedUsdc.toString(),
    balanceKes: cash.balanceKes?.toString() ?? null,
    availableKes: cash.availableKes?.toString() ?? null,
    rate: cash.rate,
    status: cash.status,
    shortKes: cash.shortKes?.toString() ?? null,
    outsideKes: cash.outsideKes.toString(),
  };
}

type OutstandingExpense = SpendingOverview["outstanding"]["claims"][number];

/**
 * Claims waiting for approval, petty cash spent without a receipt or, with
 * one, without the eTIMS invoice its category expects, and Card expenses
 * with no receipt and no admin's reason. An overspend's extra claim shares
 * its float spending's receipt and invoice.
 */
function readOutstandingExpenses(tx: Transaction, organizationId: string) {
  return query(() =>
    tx.execute<
      OutstandingExpense & { need: "approval" | "receipt" | "etims" }
    >(sql`
      SELECT id, name, "amountKes", "floatId", "spentOn", "personName",
        "categoryName", description, need
      FROM (
        SELECT e.id::text, e.merchant AS name, e.amount_kes::text AS "amountKes",
          e.float_id::text AS "floatId", e.spent_on::text AS "spentOn",
          coalesce(nullif(btrim(u.full_name), ''), u.email) AS "personName",
          c.name AS "categoryName", e.description,
          CASE
            WHEN e.kind = 'claim' THEN 'approval'
            WHEN e.kind = 'card' AND e.no_receipt_reason IS NOT NULL THEN NULL
            WHEN NOT EXISTS (
              SELECT 1 FROM receipt_files r
              WHERE r.expense_id IN (e.id, e.overspend_claim_id)
            ) THEN 'receipt'
            WHEN e.kind <> 'card' AND e.source = 'app'
              AND coalesce(extra.etims_status, e.etims_status) = 'none'
              THEN 'etims'
          END AS need,
          e.created_at
        FROM expenses e
        JOIN memberships m ON m.id = e.membership_id
        JOIN users u ON u.id = m.user_id
        JOIN categories c ON c.id = e.category_id
        LEFT JOIN expenses extra ON extra.id = e.overspend_claim_id
        WHERE e.organization_id = ${organizationId}
          AND (
            (e.kind = 'claim' AND e.status = 'submitted')
            OR (e.kind IN ('float', 'card') AND e.status = 'recorded')
          )
      ) outstanding
      WHERE need IS NOT NULL
      ORDER BY "spentOn", created_at, id
    `),
  ).pipe(
    Effect.map(({ rows }) => {
      const needing = (need: "approval" | "receipt" | "etims") =>
        rows
          .filter((row) => row.need === need)
          .map(({ need: _need, ...row }) => row);
      return {
        claims: needing("approval"),
        noReceipt: needing("receipt"),
        noEtims: needing("etims"),
      };
    }),
  );
}

/**
 * Everyone the company pays or who spends for it: its admins and
 * employees, and personnel paid without an app login (spec §6.19).
 * Accountants are left out. `current` limits it to who's on the team now;
 * otherwise a removed member or an archived payee is found too, for their
 * history.
 */
export function readPeople(
  tx: Transaction,
  organizationId: string,
  options: { readonly current: boolean; readonly id?: string },
) {
  const id = options.id ?? null;
  return query(() =>
    tx.execute<{ id: string; name: string }>(sql`
      SELECT * FROM (
        SELECT m.id::text AS id, coalesce(u.full_name, u.email) AS name
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${organizationId}
          AND m.role <> 'accountant'
          AND (NOT ${options.current} OR m.status <> 'removed')
        UNION ALL
        SELECT p.id::text, p.name FROM payees p
        WHERE p.organization_id = ${organizationId}
          AND p.membership_id IS NULL AND p.kind = 'personnel'
          AND (NOT ${options.current} OR NOT p.archived)
      ) people
      WHERE ${id}::text IS NULL OR id = ${id}::text
      ORDER BY name, id
    `),
  ).pipe(Effect.map(({ rows }) => rows));
}

export function getSpendingOverview(
  tenant: Tenant,
  selectedMonth?: string,
  now: Date = new Date(),
): Effect.Effect<
  SpendingOverview,
  DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const { organizationId } = tenant;
    const today = nairobiDate(now);
    const month = selectedMonth ?? today.slice(0, 7);
    const bounds = monthBounds(month);
    const rate = yield* activeKesRateOrNull("overview");
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const payments = yield* readSpendingPayments(tx, organizationId, {
          from: bounds.from,
          until: bounds.until,
        });
        const cash = yield* readCashCheck(
          tx,
          { organizationId, today, days: CASH_CHECK_DAYS },
          rate,
        );
        const expenses = yield* readOutstandingExpenses(tx, organizationId);
        const people = yield* readPeople(tx, organizationId, {
          current: true,
        });
        const billed = cash.obligations
          .filter((row) => row.kind !== "forecast")
          .map(serialiseObligation);
        return {
          month,
          previousMonth: bounds.previous,
          ...spendingBreakdown(payments, month),
          recentPayments: payments.slice(0, RECENT_PAYMENTS),
          outstanding: {
            overdue: billed.filter((row) => row.dueOn < today),
            dueToday: billed.filter((row) => row.dueOn === today),
            ...expenses,
          },
          cash: serialiseCash(cash),
          people,
        };
      }),
    );
  });
}

/**
 * One person (spec §6.24): their salary, what they were paid (salary,
 * claims, bills to them), their claims and their floats. `personId` is a
 * membership, or a personnel payee without one.
 */
export function getOverviewPerson(
  tenant: Tenant,
  personId: string,
): Effect.Effect<OverviewPerson, NotFound | DatabaseError, DatabaseService> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const person = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [found] = yield* readPeople(tx, organizationId, {
          current: false,
          id: personId,
        });
        if (!found) return yield* Effect.fail(personNotFound);
        const payments = yield* readSpendingPayments(tx, organizationId, {
          from: "0001-01-01",
          until: "9999-12-31",
          personId,
          withoutFloatSpending: true,
          limit: PERSON_ROWS,
        });
        const salaries = yield* query(() =>
          tx.execute<OverviewPerson["salaries"][number]>(sql`
            SELECT r.id::text, r.amount_kes::text AS "amountKes", r.active,
              r.next_due_on::text AS "nextDueOn"
            FROM recurring_items r JOIN payees p ON p.id = r.payee_id
            WHERE r.organization_id = ${organizationId}
              AND r.overview_heading = 'salaries'
              AND (p.membership_id = ${personId}::uuid OR p.id = ${personId}::uuid)
            ORDER BY r.created_at DESC, r.id
          `),
        );
        const claims = yield* query(() =>
          tx.execute<OverviewPerson["claims"][number]>(sql`
            SELECT id::text, merchant AS name, amount_kes::text AS "amountKes",
              status::text
            FROM expenses
            WHERE organization_id = ${organizationId}
              AND membership_id = ${personId}::uuid AND kind = 'claim'
            ORDER BY created_at DESC, id
            LIMIT ${PERSON_ROWS}
          `),
        );
        return {
          ...found,
          salaries: salaries.rows,
          payments,
          claims: claims.rows,
        };
      }),
    );
    const { floats } = yield* listFloats(tenant, {});
    return {
      ...person,
      floats: floats
        .filter((row) => row.holder.membershipId === personId)
        .map((row) => ({
          id: row.id,
          status: row.status,
          leftKes: row.leftKes.toString(),
        })),
    };
  });
}
