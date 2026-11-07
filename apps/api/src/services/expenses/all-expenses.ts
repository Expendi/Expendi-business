import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";

import type {
  EtimsStatus,
  ExpenseKind,
  ExpenseListKind,
  ExpenseSortKey,
  ExpenseSource,
  ExpenseStatus,
  ExpenseWarning,
  OverviewHeading,
} from "@expendi-business/shared";
import { expenseListKindOf } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { StorageError } from "../storage/file-storage.js";
import type { CompanySpendingReceiptView } from "./company.js";
import {
  bills,
  categories,
  expenses,
  memberships,
  paidFromAccounts,
  payees,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, NotFound } from "../../errors.js";
import { FileStorage } from "../storage/file-storage.js";
import { storageFailure } from "./receipts.js";
import { readWarnings } from "./rules.js";

/**
 * All expenses (spec §6.14): claims, petty cash and company spending in one
 * list, for admins and accountants; the route admits no one else. Each
 * expense row is listed once. Petty cash is spending from a float plus the
 * claims a float purchase overspent into; a float's issue and top-ups are
 * payouts in `float_movements`, never rows here. Expenses are money already
 * spent and bills money owed, so the company spending a bill marked paid
 * outside Expendi records is never listed: the bill shows in Bills. It can
 * still be opened by its ID.
 */

/** `Expense` before serialisation turns bigints and dates into strings. */
export interface ExpenseView {
  readonly id: string;
  readonly kind: ExpenseKind;
  readonly listKind: ExpenseListKind;
  readonly status: ExpenseStatus;
  readonly source: ExpenseSource;
  readonly overviewHeading: OverviewHeading;
  readonly merchant: string;
  readonly amountKes: bigint;
  readonly spentOn: string;
  readonly description: string | null;
  readonly category: { readonly id: string; readonly name: string };
  readonly member: {
    readonly membershipId: string;
    readonly name: string | null;
    readonly email: string;
  };
  readonly mpesaCode: string | null;
  readonly etimsStatus: EtimsStatus;
  readonly etimsInvoiceNumber: string | null;
  readonly etimsSupplierPin: string | null;
  readonly warnings: readonly ExpenseWarning[];
  readonly receiptCount: number;
  readonly noReceipt: boolean;
  readonly noReceiptReason: string | null;
  readonly rejectedReason: string | null;
  readonly selfApproved: boolean;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly floatId: string | null;
  readonly overspendClaimId: string | null;
  readonly bill: {
    readonly id: string;
    readonly payeeName: string;
    readonly reference: string | null;
  } | null;
  readonly paidFromAccount: {
    readonly id: string;
    readonly name: string;
  } | null;
  readonly createdAt: Date;
}

export interface ExpenseDetailView extends ExpenseView {
  readonly receipts: readonly CompanySpendingReceiptView[];
}

export interface ExpensesPageView {
  readonly expenses: readonly ExpenseView[];
  readonly nextCursor: string | null;
}

/** What `GET …/expenses` and `GET …/expenses/summary` both filter by. */
export interface ExpenseFilters {
  readonly membershipId?: string | undefined;
  readonly kind?: ExpenseListKind | undefined;
  readonly categoryId?: string | undefined;
  readonly month?: string | undefined;
  readonly etimsStatus?: EtimsStatus | undefined;
  readonly status?: ExpenseStatus | undefined;
  readonly noReceipt?: boolean | undefined;
}

export interface ExpenseListFilters extends ExpenseFilters {
  readonly sort: ExpenseSortKey;
  readonly dir: "asc" | "desc";
  readonly cursor?: string | undefined;
  readonly limit: number;
}

interface ExpenseTotalsView {
  readonly count: number;
  readonly totalKes: string;
}

/** `ExpensesSummary`: every expense the filters match. */
export interface ExpensesSummaryView extends ExpenseTotalsView {
  readonly waitingForApproval: ExpenseTotalsView;
  readonly withoutReceipt: ExpenseTotalsView;
  readonly withoutEtims: ExpenseTotalsView;
  readonly kinds: Readonly<Record<ExpenseListKind, number>>;
}

const expenseNotFound = new NotFound({ message: "Expense not found" });
const badCursor = new BadRequest({ message: "That page link isn't valid." });

const LIST_KIND_FILTERS: Readonly<Record<ExpenseListKind, SQL | undefined>> = {
  claim: and(eq(expenses.kind, "claim"), isNull(expenses.floatId)),
  petty_cash: or(
    eq(expenses.kind, "float"),
    and(eq(expenses.kind, "claim"), isNotNull(expenses.floatId)),
  ),
  company: eq(expenses.kind, "company"),
};

/** The first and last day of a `YYYY-MM` month, inclusive. */
function monthRange(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay)}` };
}

/** Its own files, its overspend claim's, and its bill's invoice and proof. */
const receiptCount = sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.expenseId} IN (${expenses.id}, ${expenses.overspendClaimId}) OR ${receiptFiles.billId} = ${expenses.billId})`;

const expenseColumns = {
  id: expenses.id,
  kind: expenses.kind,
  status: expenses.status,
  source: expenses.source,
  overviewHeading: expenses.overviewHeading,
  merchant: expenses.merchant,
  amountKes: expenses.amountKes,
  spentOn: expenses.spentOn,
  description: expenses.description,
  categoryId: categories.id,
  categoryName: categories.name,
  membershipId: expenses.membershipId,
  memberName: users.fullName,
  memberEmail: users.email,
  mpesaCode: expenses.mpesaCode,
  etimsStatus: expenses.etimsStatus,
  etimsInvoiceNumber: expenses.etimsInvoiceNumber,
  etimsSupplierPin: expenses.etimsSupplierPin,
  warnings: expenses.warnings,
  receiptCount,
  noReceiptReason: expenses.noReceiptReason,
  rejectedReason: expenses.rejectedReason,
  selfApproved: expenses.selfApproved,
  approvedAt: expenses.approvedAt,
  paidAt: expenses.paidAt,
  floatId: expenses.floatId,
  overspendClaimId: expenses.overspendClaimId,
  billId: bills.id,
  billReference: bills.reference,
  payeeName: payees.name,
  accountId: paidFromAccounts.id,
  accountName: paidFromAccounts.name,
  createdAt: expenses.createdAt,
  /** Microsecond precision, so paging never skips or repeats an expense. */
  cursorAt: sql<string>`to_char(${expenses.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

/** `sortValue` is the list's sort column as text, for its cursor. */
const selectExpenses = (
  tx: Transaction,
  where: SQL | undefined,
  sortValue: SQL = sql`NULL`,
) =>
  tx
    .select({
      ...expenseColumns,
      sortValue: sql<string | null>`(${sortValue})::text`,
    })
    .from(expenses)
    .innerJoin(categories, eq(categories.id, expenses.categoryId))
    .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(bills, eq(bills.id, expenses.billId))
    .leftJoin(payees, eq(payees.id, bills.payeeId))
    .leftJoin(
      paidFromAccounts,
      eq(paidFromAccounts.id, expenses.paidFromAccountId),
    )
    .where(where);

type ExpenseRow = Awaited<ReturnType<typeof selectExpenses>>[number];

function toExpenseView(row: ExpenseRow): ExpenseView {
  return {
    id: row.id,
    kind: row.kind,
    listKind: expenseListKindOf(row.kind, row.floatId),
    status: row.status,
    source: row.source,
    overviewHeading: row.overviewHeading,
    merchant: row.merchant,
    amountKes: row.amountKes,
    spentOn: row.spentOn,
    description: row.description,
    category: { id: row.categoryId, name: row.categoryName },
    member: {
      membershipId: row.membershipId,
      name: row.memberName,
      email: row.memberEmail,
    },
    mpesaCode: row.mpesaCode,
    etimsStatus: row.etimsStatus,
    etimsInvoiceNumber: row.etimsInvoiceNumber,
    etimsSupplierPin: row.etimsSupplierPin,
    warnings: readWarnings(row.warnings),
    receiptCount: row.receiptCount,
    noReceipt: row.receiptCount === 0,
    noReceiptReason: row.noReceiptReason,
    rejectedReason: row.rejectedReason,
    selfApproved: row.selfApproved,
    approvedAt: row.approvedAt,
    paidAt: row.paidAt,
    floatId: row.floatId,
    overspendClaimId: row.overspendClaimId,
    bill:
      row.billId === null || row.payeeName === null
        ? null
        : {
            id: row.billId,
            payeeName: row.payeeName,
            reference: row.billReference,
          },
    paidFromAccount:
      row.accountId === null || row.accountName === null
        ? null
        : { id: row.accountId, name: row.accountName },
    createdAt: row.createdAt,
  };
}

/** Payment failed first, then waiting for approval, down to recorded. */
const STATUS_URGENCY: readonly ExpenseStatus[] = [
  "payout_failed",
  "submitted",
  "paying",
  "rejected",
  "paid",
  "paid_outside",
  "recorded",
];

interface SortColumn {
  /** Needs `users` joined, for the person's name. */
  readonly expression: SQL;
  /** A cursor's value of the column, cast back to its type. */
  readonly fromCursor: (value: string) => SQL;
  readonly cursorValue: RegExp;
}

/**
 * The column each sort leads with; the purchase date, then when it was
 * recorded, break ties. Names sort case-blind, byte by byte.
 */
const SORT_COLUMNS: Readonly<
  Record<Exclude<ExpenseSortKey, "date">, SortColumn>
> = {
  person: {
    expression: sql`lower(coalesce(${users.fullName}, ${users.email})) COLLATE "C"`,
    fromCursor: (value) => sql`${value}::text COLLATE "C"`,
    cursorValue: /^[\s\S]*$/,
  },
  merchant: {
    expression: sql`lower(${expenses.merchant}) COLLATE "C"`,
    fromCursor: (value) => sql`${value}::text COLLATE "C"`,
    cursorValue: /^[\s\S]*$/,
  },
  amount: {
    expression: sql`${expenses.amountKes}`,
    fromCursor: (value) => sql`${value}::bigint`,
    cursorValue: /^\d{1,19}$/,
  },
  status: {
    expression: sql`CASE ${expenses.status} ${sql.join(
      STATUS_URGENCY.map(
        (status, rank) => sql`WHEN ${status} THEN ${sql.raw(String(rank))}`,
      ),
      sql` `,
    )} END`,
    fromCursor: (value) => sql`${value}::int`,
    cursorValue: /^\d$/,
  },
};

const sortColumnOf = (sort: ExpenseSortKey): SortColumn | null =>
  sort === "date" ? null : SORT_COLUMNS[sort];

/**
 * The last row of a page: its purchase date, when it was recorded and its
 * ID, then the sort column's value unless the sort is by date.
 */
const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|([\s\S]*))?$/;

const encodeCursor = (row: ExpenseRow): string =>
  Buffer.from(
    [row.spentOn, row.cursorAt, row.id, row.sortValue]
      .filter((part) => part !== null)
      .join("|"),
    "utf8",
  ).toString("base64url");

/**
 * The rows after a page's cursor, in the sort's order and `dir`. Only a
 * cursor from a page of the same sort is taken.
 */
function afterCursor(
  cursor: string,
  column: SortColumn | null,
  dir: "asc" | "desc",
): Effect.Effect<SQL, BadRequest> {
  const match = CURSOR_PATTERN.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (!match?.[1] || !match[2] || !match[3]) return Effect.fail(badCursor);
  const [, spentOn, at, id, value] = match;
  const rowKeys: SQL[] = [
    sql`${expenses.spentOn}`,
    sql`${expenses.createdAt}`,
    sql`${expenses.id}`,
  ];
  const cursorKeys: SQL[] = [
    sql`${spentOn}::date`,
    sql`${at}::timestamptz`,
    sql`${id}::uuid`,
  ];
  const after = (left: SQL[], right: SQL[]): SQL =>
    sql`(${sql.join(left, sql`, `)}) ${dir === "asc" ? sql`>` : sql`<`} (${sql.join(right, sql`, `)})`;
  if (column === null) {
    return value === undefined
      ? Effect.succeed(after(rowKeys, cursorKeys))
      : Effect.fail(badCursor);
  }
  return value !== undefined && column.cursorValue.test(value)
    ? Effect.succeed(
        after(
          [column.expression, ...rowKeys],
          [column.fromCursor(value), ...cursorKeys],
        ),
      )
    : Effect.fail(badCursor);
}

/** Every expense the list can show: the company's, bills' spending aside. */
const listedExpenses = (tenant: Tenant): SQL | undefined =>
  and(
    eq(expenses.organizationId, tenant.organizationId),
    isNull(expenses.billId),
  );

function filtersWhere(filters: ExpenseFilters): SQL | undefined {
  const month =
    filters.month === undefined ? undefined : monthRange(filters.month);
  return and(
    filters.membershipId === undefined
      ? undefined
      : eq(expenses.membershipId, filters.membershipId),
    filters.kind === undefined ? undefined : LIST_KIND_FILTERS[filters.kind],
    filters.categoryId === undefined
      ? undefined
      : eq(expenses.categoryId, filters.categoryId),
    month === undefined
      ? undefined
      : and(gte(expenses.spentOn, month.from), lte(expenses.spentOn, month.to)),
    filters.etimsStatus === undefined
      ? undefined
      : eq(expenses.etimsStatus, filters.etimsStatus),
    filters.status === undefined
      ? undefined
      : eq(expenses.status, filters.status),
    filters.noReceipt === undefined
      ? undefined
      : filters.noReceipt
        ? sql`${receiptCount} = 0`
        : sql`${receiptCount} > 0`,
  );
}

/**
 * A page at a time, in the sort asked for: by default the latest purchase
 * date first, then the latest recorded.
 */
export function listExpenses(
  tenant: Tenant,
  filters: ExpenseListFilters,
): Effect.Effect<
  ExpensesPageView,
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const column = sortColumnOf(filters.sort);
    const after =
      filters.cursor === undefined
        ? undefined
        : yield* afterCursor(filters.cursor, column, filters.dir);
    const order = filters.dir === "asc" ? asc : desc;
    const rows = yield* withScope(tenant, (tx) =>
      query(() =>
        selectExpenses(
          tx,
          and(listedExpenses(tenant), filtersWhere(filters), after),
          column?.expression,
        )
          .orderBy(
            ...(column === null ? [] : [order(column.expression)]),
            order(expenses.spentOn),
            order(expenses.createdAt),
            order(expenses.id),
          )
          .limit(filters.limit + 1),
      ),
    );
    const page = rows.slice(0, filters.limit);
    const last = page.at(-1);
    return {
      expenses: page.map(toExpenseView),
      nextCursor:
        rows.length > filters.limit && last ? encodeCursor(last) : null,
    };
  });
}

/** Every condition holds; no conditions holds always. */
const allOf = (...conditions: (SQL | undefined)[]): SQL =>
  and(...conditions) ?? sql`TRUE`;

const totalsWhere = (condition: SQL) => ({
  count: sql<number>`count(*) FILTER (WHERE ${condition})::int`,
  totalKes: sql<string>`coalesce(sum(${expenses.amountKes}) FILTER (WHERE ${condition}), 0)::text`,
});

/**
 * The numbers above the list: every expense the filters match, however
 * many pages that is, and how many each kind's tab would hold.
 */
export function expensesSummary(
  tenant: Tenant,
  filters: ExpenseFilters,
): Effect.Effect<ExpensesSummaryView, DatabaseError, DatabaseService> {
  const shown = allOf(
    filters.kind === undefined ? undefined : LIST_KIND_FILTERS[filters.kind],
  );
  const kindCount = (kind: ExpenseListKind) =>
    sql<number>`count(*) FILTER (WHERE ${allOf(LIST_KIND_FILTERS[kind])})::int`;
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select({
          shown: totalsWhere(shown),
          waitingForApproval: totalsWhere(
            allOf(shown, eq(expenses.status, "submitted")),
          ),
          withoutReceipt: totalsWhere(allOf(shown, sql`${receiptCount} = 0`)),
          withoutEtims: totalsWhere(
            allOf(shown, eq(expenses.etimsStatus, "none")),
          ),
          claim: kindCount("claim"),
          pettyCash: kindCount("petty_cash"),
          company: kindCount("company"),
        })
        .from(expenses)
        .where(
          and(
            listedExpenses(tenant),
            filtersWhere({ ...filters, kind: undefined }),
          ),
        ),
    ).pipe(
      Effect.flatMap(([row]) =>
        row
          ? Effect.succeed({
              ...row.shown,
              waitingForApproval: row.waitingForApproval,
              withoutReceipt: row.withoutReceipt,
              withoutEtims: row.withoutEtims,
              kinds: {
                claim: row.claim,
                petty_cash: row.pettyCash,
                company: row.company,
              },
            })
          : Effect.dieMessage("an aggregate query returned no row"),
      ),
    ),
  );
}

/**
 * One expense with short-lived links to its receipts: its own, the claim
 * its float purchase overspent into (which holds the purchase's evidence),
 * and its bill's invoice and proof.
 */
export function getExpense(
  tenant: Tenant,
  expenseId: string,
): Effect.Effect<
  ExpenseDetailView,
  NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    const { row, files } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          selectExpenses(
            tx,
            and(
              eq(expenses.organizationId, tenant.organizationId),
              eq(expenses.id, expenseId),
            ),
          ).limit(1),
        );
        if (!row) return yield* Effect.fail(expenseNotFound);
        const files = yield* query(() =>
          tx
            .select({
              id: receiptFiles.id,
              kind: receiptFiles.kind,
              billRole: receiptFiles.billRole,
              contentType: receiptFiles.contentType,
              storageKey: receiptFiles.storageKey,
              smsText: receiptFiles.smsText,
            })
            .from(receiptFiles)
            .where(
              and(
                eq(receiptFiles.organizationId, tenant.organizationId),
                or(
                  inArray(
                    receiptFiles.expenseId,
                    row.overspendClaimId === null
                      ? [row.id]
                      : [row.id, row.overspendClaimId],
                  ),
                  row.billId === null
                    ? undefined
                    : eq(receiptFiles.billId, row.billId),
                ),
              ),
            )
            .orderBy(asc(receiptFiles.createdAt), asc(receiptFiles.id)),
        );
        return { row, files };
      }),
    );
    const receipts = yield* Effect.forEach(
      files,
      (file): Effect.Effect<CompanySpendingReceiptView, StorageError> => {
        if (file.kind === "sms_text" || file.storageKey === null) {
          return Effect.succeed({
            id: file.id,
            kind: "sms_text",
            billRole: null,
            text: file.smsText ?? "",
          });
        }
        const kind = file.kind;
        return storage.presignDownload(file.storageKey).pipe(
          Effect.map(({ url, expiresAt }) => ({
            id: file.id,
            kind,
            billRole: file.billRole,
            contentType: file.contentType,
            url,
            expiresAt,
          })),
        );
      },
    ).pipe(Effect.mapError(storageFailure));
    return { ...toExpenseView(row), receipts };
  });
}
