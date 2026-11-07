import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  bills,
  categories,
  expenses,
  floatMovements,
  floats,
  importRuns,
  memberships,
  organizations,
  paidFromAccounts,
  payees,
  payouts,
  payrollRuns,
  recurringItems,
  reportExports,
  users,
  withdrawalAddresses,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { UUID } from "../staff/paging.js";

/**
 * Names for the records audit entries and syncs point at, as people know
 * them: "Twiga Foods, INV-4471" for a bill, "Kevin Mwangi's petty cash" for
 * a float. Read inside the company's scope, so row-level security and the
 * company filter both apply; a record that can't be read gets no name.
 */

export interface EntityRef {
  readonly type: string;
  readonly id: string | null;
}

export const entityKey = (type: string, id: string): string =>
  `${type}:${id.toLowerCase()}`;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-10` or `2026-10-28` as "October 2026". */
function monthName(date: string): string {
  const [year = "", month = "1"] = date.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

const personName = sql<string>`coalesce(nullif(btrim(${users.fullName}), ''), ${users.email})`;

const withDetail = (name: string, detail: string | null): string =>
  detail ? `${name}, ${detail}` : name;

type Labelled = readonly (readonly [string, string])[];

type Lookup = (
  tx: Transaction,
  organizationId: string,
  ids: string[],
) => Effect.Effect<Labelled, DatabaseError>;

const billLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({
        id: bills.id,
        payee: payees.name,
        detail: sql<
          string | null
        >`coalesce(nullif(btrim(${bills.reference}), ''), nullif(btrim(${bills.notes}), ''))`,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .where(
        and(eq(bills.organizationId, organizationId), inArray(bills.id, ids)),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => [row.id, withDetail(row.payee, row.detail)] as const),
    ),
  );

const expenseLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({
        id: expenses.id,
        merchant: expenses.merchant,
        kind: expenses.kind,
        person: personName,
      })
      .from(expenses)
      .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          inArray(expenses.id, ids),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map(
        (row) =>
          [
            row.id,
            withDetail(
              row.merchant,
              row.kind === "company" ? null : row.person,
            ),
          ] as const,
      ),
    ),
  );

const named =
  (
    select: (
      tx: Transaction,
      organizationId: string,
      ids: string[],
    ) => Promise<{ id: string; name: string }[]>,
  ): Lookup =>
  (tx, organizationId, ids) =>
    query(() => select(tx, organizationId, ids)).pipe(
      Effect.map((rows) => rows.map((row) => [row.id, row.name] as const)),
    );

const payeeLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: payees.id, name: payees.name })
    .from(payees)
    .where(
      and(eq(payees.organizationId, organizationId), inArray(payees.id, ids)),
    ),
);

const categoryLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      and(
        eq(categories.organizationId, organizationId),
        inArray(categories.id, ids),
      ),
    ),
);

const paidFromAccountLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: paidFromAccounts.id, name: paidFromAccounts.name })
    .from(paidFromAccounts)
    .where(
      and(
        eq(paidFromAccounts.organizationId, organizationId),
        inArray(paidFromAccounts.id, ids),
      ),
    ),
);

const membershipLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: memberships.id, name: personName })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        inArray(memberships.id, ids),
      ),
    ),
);

/** Only people who are or were in this company. */
const userLabels = named((tx, organizationId, ids) =>
  tx
    .selectDistinct({ id: users.id, name: personName })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        inArray(users.id, ids),
      ),
    ),
);

const withdrawalAddressLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: withdrawalAddresses.id, name: withdrawalAddresses.label })
    .from(withdrawalAddresses)
    .where(
      and(
        eq(withdrawalAddresses.organizationId, organizationId),
        inArray(withdrawalAddresses.id, ids),
      ),
    ),
);

const importLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: importRuns.id, name: importRuns.fileName })
    .from(importRuns)
    .where(
      and(
        eq(importRuns.organizationId, organizationId),
        inArray(importRuns.id, ids),
      ),
    ),
);

const organizationLabels = named((tx, organizationId, ids) =>
  tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(
      and(eq(organizations.id, organizationId), inArray(organizations.id, ids)),
    ),
);

const payrollRunLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({ id: payrollRuns.id, payDate: payrollRuns.payDate })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.organizationId, organizationId),
          inArray(payrollRuns.id, ids),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map(
        (row) => [row.id, `Payroll for ${monthName(row.payDate)}`] as const,
      ),
    ),
  );

const reportExportLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({ id: reportExports.id, month: reportExports.month })
      .from(reportExports)
      .where(
        and(
          eq(reportExports.organizationId, organizationId),
          inArray(reportExports.id, ids),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => [row.id, `${monthName(row.month)} export`] as const),
    ),
  );

const recurringItemLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({
        id: recurringItems.id,
        payee: payees.name,
        heading: recurringItems.overviewHeading,
        schedule: recurringItems.schedule,
      })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          inArray(recurringItems.id, ids),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map(
        (row) =>
          [
            row.id,
            row.heading === "salaries"
              ? `${row.payee}'s salary`
              : withDetail(row.payee, row.schedule),
          ] as const,
      ),
    ),
  );

const floatLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({ id: floats.id, name: personName })
      .from(floats)
      .innerJoin(memberships, eq(memberships.id, floats.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(floats.organizationId, organizationId), inArray(floats.id, ids)),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => [row.id, `${row.name}'s petty cash`] as const),
    ),
  );

const floatMovementLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({ id: floatMovements.id, name: personName })
      .from(floatMovements)
      .innerJoin(floats, eq(floats.id, floatMovements.floatId))
      .innerJoin(memberships, eq(memberships.id, floats.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(floatMovements.organizationId, organizationId),
          inArray(floatMovements.id, ids),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => [row.id, `${row.name}'s petty cash`] as const),
    ),
  );

const payoutLabels: Lookup = (tx, organizationId, ids) =>
  query(() =>
    tx
      .select({
        id: payouts.id,
        subjectType: payouts.subjectType,
        recipient: payouts.recipient,
      })
      .from(payouts)
      .where(
        and(
          eq(payouts.organizationId, organizationId),
          inArray(payouts.id, ids),
        ),
      ),
  ).pipe(
    Effect.map((rows) =>
      rows.map(
        (row) =>
          [
            row.id,
            `${row.subjectType === "withdrawal" ? "Withdrawal" : "Payment"} to ${row.recipient.accountName}`,
          ] as const,
      ),
    ),
  );

const LOOKUPS: Readonly<Record<string, Lookup>> = {
  bill: billLabels,
  category: categoryLabels,
  expense: expenseLabels,
  float: floatLabels,
  float_movement: floatMovementLabels,
  import_run: importLabels,
  membership: membershipLabels,
  organization: organizationLabels,
  paid_from_account: paidFromAccountLabels,
  payee: payeeLabels,
  payout: payoutLabels,
  payroll_run: payrollRunLabels,
  recurring_item: recurringItemLabels,
  report_export: reportExportLabels,
  user: userLabels,
  withdrawal_address: withdrawalAddressLabels,
};

/** Names keyed by `entityKey(type, id)`; records without one are left out. */
export function entityLabels(
  tx: Transaction,
  organizationId: string,
  refs: readonly EntityRef[],
): Effect.Effect<Map<string, string>, DatabaseError> {
  const idsByType = new Map<string, Set<string>>();
  for (const { type, id } of refs) {
    if (id === null || !UUID.test(id) || !Object.hasOwn(LOOKUPS, type)) {
      continue;
    }
    idsByType.set(
      type,
      (idsByType.get(type) ?? new Set()).add(id.toLowerCase()),
    );
  }
  return Effect.forEach([...idsByType], ([type, ids]) => {
    const lookup = LOOKUPS[type];
    return lookup
      ? lookup(tx, organizationId, [...ids]).pipe(
          Effect.map((rows) =>
            rows.map(([id, label]) => [entityKey(type, id), label] as const),
          ),
        )
      : Effect.succeed([]);
  }).pipe(Effect.map((groups) => new Map(groups.flat())));
}
