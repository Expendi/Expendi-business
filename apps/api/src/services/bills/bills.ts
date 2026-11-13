import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";

import type {
  BillCurrency,
  BillListView,
  BillMethodFilter,
  BillSource,
  BillStatus,
  CashOutReceipt,
  CreateBillFields,
  MarkBillPaidOutsideFields,
  OverviewHeading,
  PayeeKind,
  PayeeMethod,
  PayoutStatus,
  RecurringItemState,
  RecurringSchedule,
  UpdateBillFields,
} from "@expendi-business/shared";
import {
  BILL_LIST_VIEW_STATUSES,
  currencyForPayeeMethod,
  DATED_BILL_STATUSES,
  defaultBillHeading,
  SETTLED_BILL_STATUSES,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BillRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { FileStorage } from "../storage/file-storage.js";
import type { BillFileView } from "./files.js";
import {
  bills,
  categories,
  expenses,
  paidFromAccounts,
  payees,
  payouts,
  receiptFiles,
  recurringItems,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  activeCashOutLimits,
  checkCashOutAmount,
} from "../cash-out/active-limits.js";
import { activeKesRate } from "../cash-out/active-rate.js";
import { recordBillSpending } from "../expenses/company.js";
import { kesCentsFor } from "../paycrest/amounts.js";
import { paymentReceiptsBySubject } from "../payout/receipts.js";
import { onRecurringBillSettled } from "../recurring/next-bill.js";
import { recurringItemState } from "../recurring/recurring-items.js";
import { enqueuePaidBill } from "../zoho/enqueue.js";
import {
  attachBillFiles,
  billFileLinks,
  checkAttachableBillFiles,
  readBillFiles,
} from "./files.js";
import { billAmountOf } from "./payable.js";
import { nairobiDate, scheduledStatus } from "./status.js";

/**
 * One-off bills (spec §6.20), for admins only (spec §4): the routes admit
 * admins, and row-level security hides bills from any other role. A bill
 * can change until it's paid, being paid or cancelled. Every change is
 * audited in its own transaction.
 *
 * Paying a bill through Expendi is T37 (`assertBillPayable`), and salary
 * bills belong to payroll runs (T38), so these routes don't change them.
 * Settling a recurring bill (T36) creates its next one in the same
 * transaction (`onRecurringBillSettled`).
 */

export interface BillPersonView {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string;
}

/** `Bill` before serialisation turns bigints and dates into strings. */
export interface BillView {
  readonly id: string;
  readonly status: BillStatus;
  readonly payee: {
    readonly id: string;
    readonly name: string;
    readonly kind: PayeeKind;
    readonly method: PayeeMethod | null;
    readonly archived: boolean;
  };
  readonly overviewHeading: OverviewHeading;
  readonly category: { readonly id: string; readonly name: string };
  readonly variable: boolean;
  readonly currency: BillCurrency;
  readonly amountKes: bigint | null;
  readonly amountUsdc: bigint | null;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly dueOn: string;
  readonly recurringItemId: string | null;
  readonly payrollRunId: string | null;
  readonly adjustmentReason: string | null;
  readonly paidOn: string | null;
  readonly paidAt: Date | null;
  readonly markedPaidBy: BillPersonView | null;
  readonly paidOutsideNote: string | null;
  readonly cancelledReason: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: BillPersonView | null;
  readonly payoutId: string | null;
  readonly paymentReceipts: readonly CashOutReceipt[];
  readonly fileCount: number;
  readonly recurring: {
    readonly id: string;
    readonly state: RecurringItemState;
    readonly schedule: RecurringSchedule;
    readonly scheduleDay: number;
    readonly startsOn: string;
  } | null;
  readonly paidFromAccount: {
    readonly id: string;
    readonly name: string;
  } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BillDetailView extends BillView {
  readonly files: readonly BillFileView[];
  readonly payout: {
    readonly id: string;
    readonly status: PayoutStatus;
    readonly failureReason: string | null;
  } | null;
}

/** What `GET …/bills` and `GET …/bills/summary` both filter by. */
export interface BillFilterFields {
  readonly heading?: OverviewHeading | undefined;
  readonly payeeId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly method?: BillMethodFilter | undefined;
  readonly source?: BillSource | undefined;
  readonly dueFrom?: string | undefined;
  readonly dueTo?: string | undefined;
  /** Leaves out bills settled before this Nairobi day. */
  readonly settledFrom?: string | undefined;
}

export interface BillFilters extends BillFilterFields {
  readonly view?: BillListView | undefined;
  readonly status?: readonly BillStatus[] | undefined;
  readonly excludePayroll?: boolean | undefined;
  readonly limit: number;
}

interface BillTotalsView {
  readonly count: number;
  readonly totalKes: string;
  readonly totalUsdc: string;
}

/** `BillsSummary`: counts per tab with the filters, the rest company-wide. */
export interface BillsSummaryView {
  readonly views: Readonly<Record<BillListView, number>>;
  readonly toPay: BillTotalsView & { readonly withoutAmount: number };
  readonly overdue: BillTotalsView;
  readonly dueToday: BillTotalsView;
  readonly payoutFailed: BillTotalsView;
}

type BillDeps = DatabaseService | AuditLog | FileStorage;
type BillError =
  BadRequest | Conflict | NotFound | ServiceUnavailable | DatabaseError;

const billNotFound = new NotFound({ message: "That bill wasn't found." });
const unknownPayee = new BadRequest({
  message: "Pick one of the company's payees.",
});
const archivedPayee = new BadRequest({
  message: "This payee is archived. Pick another, or add them again.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});
const payrollBill = new Conflict({
  message: "This is a salary payment. Change it in its payroll run.",
});
const noAmount = new Conflict({
  message: "Enter the bill's amount before marking it paid.",
});
const futurePayment = new BadRequest({
  message: "The date it was paid can't be in the future.",
});
const rateUnavailable = new ServiceUnavailable({
  message:
    "Couldn't get today's KES rate to record this USD bill in KES. Try again in a minute.",
});
const changedMeanwhile = new Conflict({
  message: "This bill changed while you were marking it paid. Try again.",
});

const CURRENCY_NAMES: Readonly<Record<BillCurrency, string>> = {
  kes: "KES",
  usd: "USD",
};

const SETTLED_MESSAGES: Partial<Record<BillStatus, string>> = {
  paying: "This bill is being paid, so it can't be changed.",
  paid: "This bill is paid, so it can't be changed.",
  paid_outside: "This bill was marked paid, so it can't be changed.",
  cancelled: "This bill is cancelled, so it can't be changed.",
};

const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

const followsDueDate = (status: BillStatus): boolean =>
  (DATED_BILL_STATUSES as readonly BillStatus[]).includes(status);

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

// ── Reading ──────────────────────────────────────────────────────────────

const markedBy = alias(users, "marked_by");
const cancelledBy = alias(users, "cancelled_by");
/** The company spending a bill marked paid outside Expendi recorded; at most one. */
const billSpending = alias(expenses, "bill_spending");

const billColumns = {
  bill: bills,
  payeeName: payees.name,
  payeeKind: payees.kind,
  payeeMethod: payees.method,
  payeeArchived: payees.archived,
  categoryName: categories.name,
  markedByName: markedBy.fullName,
  markedByEmail: markedBy.email,
  cancelledByName: cancelledBy.fullName,
  cancelledByEmail: cancelledBy.email,
  fileCount: sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.billId} = ${bills.id})`,
  recurringActive: recurringItems.active,
  recurringNextDueOn: recurringItems.nextDueOn,
  recurringSchedule: recurringItems.schedule,
  recurringScheduleDay: recurringItems.scheduleDay,
  recurringStartsOn: recurringItems.startsOn,
  accountId: paidFromAccounts.id,
  accountName: paidFromAccounts.name,
};

const selectBills = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(billColumns)
    .from(bills)
    .innerJoin(payees, eq(payees.id, bills.payeeId))
    .innerJoin(categories, eq(categories.id, bills.categoryId))
    .leftJoin(markedBy, eq(markedBy.id, bills.markedPaidBy))
    .leftJoin(cancelledBy, eq(cancelledBy.id, bills.cancelledBy))
    .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
    .leftJoin(billSpending, eq(billSpending.billId, bills.id))
    .leftJoin(
      paidFromAccounts,
      eq(paidFromAccounts.id, billSpending.paidFromAccountId),
    )
    .where(where);

type SelectedBill = Awaited<ReturnType<typeof selectBills>>[number];

function person(
  userId: string | null,
  name: string | null,
  email: string | null,
): BillPersonView | null {
  return userId === null || email === null ? null : { userId, name, email };
}

function toBillView(
  row: SelectedBill,
  paymentReceipts: readonly CashOutReceipt[],
): BillView {
  const { bill } = row;
  return {
    id: bill.id,
    status: bill.status,
    payee: {
      id: bill.payeeId,
      name: row.payeeName,
      kind: row.payeeKind,
      method: row.payeeMethod,
      archived: row.payeeArchived,
    },
    overviewHeading: bill.overviewHeading,
    category: { id: bill.categoryId, name: row.categoryName },
    variable: bill.variable,
    currency: bill.currency,
    amountKes: bill.amountKes,
    amountUsdc: bill.amountUsdc,
    reference: bill.reference,
    notes: bill.notes,
    dueOn: bill.dueOn,
    recurringItemId: bill.recurringItemId,
    payrollRunId: bill.payrollRunId,
    adjustmentReason: bill.adjustmentReason,
    paidOn: bill.paidOn,
    paidAt: bill.paidAt,
    markedPaidBy: person(
      bill.markedPaidBy,
      row.markedByName,
      row.markedByEmail,
    ),
    paidOutsideNote: bill.paidOutsideNote,
    cancelledReason: bill.cancelledReason,
    cancelledAt: bill.cancelledAt,
    cancelledBy: person(
      bill.cancelledBy,
      row.cancelledByName,
      row.cancelledByEmail,
    ),
    payoutId: bill.payoutId,
    paymentReceipts,
    fileCount: row.fileCount,
    recurring:
      bill.recurringItemId === null ||
      row.recurringActive === null ||
      row.recurringSchedule === null ||
      row.recurringScheduleDay === null ||
      row.recurringStartsOn === null
        ? null
        : {
            id: bill.recurringItemId,
            state: recurringItemState({
              active: row.recurringActive,
              nextDueOn: row.recurringNextDueOn,
            }),
            schedule: row.recurringSchedule,
            scheduleDay: row.recurringScheduleDay,
            startsOn: row.recurringStartsOn,
          },
    paidFromAccount:
      row.accountId === null || row.accountName === null
        ? null
        : { id: row.accountId, name: row.accountName },
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
  };
}

/** Every condition holds; no conditions holds always. */
const allOf = (...conditions: (SQL | undefined)[]): SQL =>
  and(...conditions) ?? sql`TRUE`;

/** The Nairobi day a bill was settled: paid (either way), or cancelled. */
const settledOn = sql`coalesce(${bills.paidOn}, (${bills.cancelledAt} AT TIME ZONE 'Africa/Nairobi')::date, ${bills.dueOn})`;

/** Needs `payees` joined, for the payee's method. */
function filtersWhere(filters: BillFilterFields): SQL | undefined {
  const { method, source } = filters;
  return and(
    filters.heading === undefined
      ? undefined
      : eq(bills.overviewHeading, filters.heading),
    filters.payeeId === undefined
      ? undefined
      : eq(bills.payeeId, filters.payeeId),
    filters.categoryId === undefined
      ? undefined
      : eq(bills.categoryId, filters.categoryId),
    method === undefined
      ? undefined
      : method === "none"
        ? isNull(payees.method)
        : eq(payees.method, method),
    source === undefined
      ? undefined
      : source === "recurring"
        ? isNotNull(bills.recurringItemId)
        : isNull(bills.recurringItemId),
    filters.dueFrom === undefined
      ? undefined
      : gte(bills.dueOn, filters.dueFrom),
    filters.dueTo === undefined ? undefined : lte(bills.dueOn, filters.dueTo),
    filters.settledFrom === undefined
      ? undefined
      : or(
          notInArray(bills.status, [...SETTLED_BILL_STATUSES]),
          sql`${settledOn} >= ${filters.settledFrom}::date`,
        ),
  );
}

const withStatus = (statuses: readonly BillStatus[]): SQL =>
  inArray(bills.status, [...statuses]);

/** Sorted by due date, earliest first. */
export function listBills(
  tenant: Tenant,
  filters: BillFilters,
): Effect.Effect<BillView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const rows = yield* query(() =>
        selectBills(
          tx,
          and(
            eq(bills.organizationId, tenant.organizationId),
            filters.view === undefined
              ? undefined
              : withStatus(BILL_LIST_VIEW_STATUSES[filters.view]),
            filters.status === undefined
              ? undefined
              : withStatus(filters.status),
            filters.excludePayroll ? isNull(bills.payrollRunId) : undefined,
            filtersWhere(filters),
          ),
        )
          .orderBy(asc(bills.dueOn), asc(bills.createdAt), asc(bills.id))
          .limit(filters.limit),
      );
      const receipts = yield* paymentReceiptsBySubject(
        tx,
        tenant.organizationId,
        "bill",
        rows.map((row) => row.bill.id),
      );
      return rows.map((row) =>
        toBillView(row, receipts.get(row.bill.id) ?? []),
      );
    }),
  );
}

const countWhere = (condition: SQL) =>
  sql<number>`count(*) FILTER (WHERE ${condition})::int`;

/** KES bills carry `amount_kes` and USD bills `amount_usdc`; the other is null. */
const totalsWhere = (condition: SQL) => ({
  count: countWhere(condition),
  totalKes: sql<string>`coalesce(sum(${bills.amountKes}) FILTER (WHERE ${condition}), 0)::text`,
  totalUsdc: sql<string>`coalesce(sum(${bills.amountUsdc}) FILTER (WHERE ${condition}), 0)::text`,
});

/**
 * How many bills each tab of the Bills page holds with `filters`, and the
 * numbers on its cards over every bill still to pay, whatever the filters.
 * Salary bills are Payroll's, so neither counts them.
 */
export function billsSummary(
  tenant: Tenant,
  filters: BillFilterFields,
): Effect.Effect<BillsSummaryView, DatabaseError, DatabaseService> {
  const filtered = filtersWhere(filters);
  const unpaid = withStatus(UNPAID_BILL_STATUSES);
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select({
          open: countWhere(
            allOf(filtered, withStatus(BILL_LIST_VIEW_STATUSES.open)),
          ),
          paying: countWhere(
            allOf(filtered, withStatus(BILL_LIST_VIEW_STATUSES.paying)),
          ),
          history: countWhere(
            allOf(filtered, withStatus(BILL_LIST_VIEW_STATUSES.history)),
          ),
          toPay: totalsWhere(unpaid),
          withoutAmount: countWhere(
            allOf(unpaid, isNull(bills.amountKes), isNull(bills.amountUsdc)),
          ),
          overdue: totalsWhere(eq(bills.status, "overdue")),
          dueToday: totalsWhere(eq(bills.status, "due")),
          payoutFailed: totalsWhere(eq(bills.status, "payout_failed")),
        })
        .from(bills)
        .innerJoin(payees, eq(payees.id, bills.payeeId))
        .where(
          and(
            eq(bills.organizationId, tenant.organizationId),
            isNull(bills.payrollRunId),
          ),
        ),
    ).pipe(
      Effect.flatMap(([row]) =>
        row
          ? Effect.succeed({
              views: {
                open: row.open,
                paying: row.paying,
                history: row.history,
              },
              toPay: { ...row.toPay, withoutAmount: row.withoutAmount },
              overdue: row.overdue,
              dueToday: row.dueToday,
              payoutFailed: row.payoutFailed,
            })
          : Effect.dieMessage("an aggregate query returned no row"),
      ),
    ),
  );
}

/**
 * A bill with short-lived links to its invoice and any proof of payment,
 * and its latest payment through Expendi.
 */
export function getBill(
  tenant: Tenant,
  billId: string,
): Effect.Effect<
  BillDetailView,
  NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const { row, files, payout, receipts } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          selectBills(
            tx,
            and(
              eq(bills.organizationId, tenant.organizationId),
              eq(bills.id, billId),
            ),
          ).limit(1),
        );
        if (!row) return yield* Effect.fail(billNotFound);
        const payoutId = row.bill.payoutId;
        const [payout] =
          payoutId === null
            ? []
            : yield* query(() =>
                tx
                  .select({
                    id: payouts.id,
                    status: payouts.status,
                    failureReason: payouts.failureReason,
                  })
                  .from(payouts)
                  .where(
                    and(
                      eq(payouts.organizationId, tenant.organizationId),
                      eq(payouts.id, payoutId),
                    ),
                  ),
              );
        const files = yield* readBillFiles(tx, tenant.organizationId, billId);
        const receipts = yield* paymentReceiptsBySubject(
          tx,
          tenant.organizationId,
          "bill",
          [billId],
        );
        return {
          row,
          files,
          payout: payout ?? null,
          receipts: receipts.get(billId) ?? [],
        };
      }),
    );
    return {
      ...toBillView(row, receipts),
      files: yield* billFileLinks(files),
      payout,
    };
  });
}

// ── Checks ───────────────────────────────────────────────────────────────

interface BillPayee {
  readonly name: string;
  readonly kind: PayeeKind;
  readonly method: PayeeMethod | null;
  readonly archived: boolean;
}

const selectBillPayee = (tx: Transaction) =>
  tx
    .select({
      name: payees.name,
      kind: payees.kind,
      method: payees.method,
      archived: payees.archived,
    })
    .from(payees);

/** An archived payee keeps its bills but can't be given new ones. */
function findPayee(
  tx: Transaction,
  organizationId: string,
  payeeId: string,
): Effect.Effect<BillPayee, BadRequest | DatabaseError> {
  return query(() =>
    selectBillPayee(tx)
      .where(
        and(eq(payees.organizationId, organizationId), eq(payees.id, payeeId)),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([payee]) => {
      if (!payee) return Effect.fail(unknownPayee);
      return payee.archived
        ? Effect.fail(archivedPayee)
        : Effect.succeed(payee);
    }),
  );
}

/** The bill's own payee, archived or not. */
function payeeOfBill(
  tx: Transaction,
  row: BillRow,
): Effect.Effect<BillPayee, DatabaseError> {
  return query(() =>
    selectBillPayee(tx)
      .where(
        and(
          eq(payees.organizationId, row.organizationId),
          eq(payees.id, row.payeeId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([payee]) =>
      payee
        ? Effect.succeed(payee)
        : Effect.dieMessage(`bill ${row.id} lost its payee`),
    ),
  );
}

interface TypedAmount {
  readonly currency: BillCurrency;
  /** Null clears it, making a variable bill wait for its amount. */
  readonly value: bigint | null;
}

/** The amount the request typed, if any, and the currency it was typed in. */
function typedAmount(fields: {
  readonly amountKes?: bigint | null | undefined;
  readonly amountUsd?: bigint | null | undefined;
}): TypedAmount | undefined {
  if (fields.amountUsd !== undefined) {
    return { currency: "usd", value: fields.amountUsd };
  }
  if (fields.amountKes !== undefined) {
    return { currency: "kes", value: fields.amountKes };
  }
  return undefined;
}

/**
 * A payee paid in USDC is billed in USD and paid exactly that USDC; every
 * other payee in KES (spec §6.19). An amount typed in the other currency is
 * refused rather than converted.
 */
function checkCurrency(
  payee: BillPayee,
  currency: BillCurrency,
  typed: TypedAmount | undefined,
): Effect.Effect<void, BadRequest> {
  if (typed === undefined || typed.currency === currency) return Effect.void;
  return Effect.fail(
    new BadRequest({
      message:
        currency === "usd"
          ? `${payee.name} is paid in USDC, so enter the amount in USD.`
          : `${payee.name} is paid in KES, so enter the amount in KES.`,
    }),
  );
}

/** The amount columns for `value` in `currency`; the other currency's is null. */
const amountColumns = (currency: BillCurrency, value: bigint | null) => ({
  currency,
  amountKes: currency === "kes" ? value : null,
  amountUsdc: currency === "usd" ? value : null,
});

function checkCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
): Effect.Effect<void, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select({ archived: categories.archived })
      .from(categories)
      .where(
        and(
          eq(categories.organizationId, organizationId),
          eq(categories.id, categoryId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([category]) =>
      category && !category.archived
        ? Effect.void
        : Effect.fail(unknownCategory),
    ),
  );
}

/** The bill, locked for the rest of the transaction. */
function lockBill(
  tx: Transaction,
  organizationId: string,
  billId: string,
): Effect.Effect<BillRow, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(bills)
      .where(
        and(eq(bills.organizationId, organizationId), eq(bills.id, billId)),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(billNotFound),
    ),
  );
}

/** A one-off or recurring bill that hasn't been paid, isn't being paid and isn't cancelled. */
function lockUnpaidBill(
  tx: Transaction,
  organizationId: string,
  billId: string,
): Effect.Effect<BillRow, NotFound | Conflict | DatabaseError> {
  return lockBill(tx, organizationId, billId).pipe(
    Effect.filterOrFail(
      (row) => row.payrollRunId === null,
      () => payrollBill,
    ),
    Effect.filterOrFail(
      (row) => isUnpaid(row.status),
      (row) =>
        new Conflict({
          message:
            SETTLED_MESSAGES[row.status] ?? "This bill can't be changed now.",
        }),
    ),
  );
}

// ── Changes ──────────────────────────────────────────────────────────────

/**
 * A one-off bill entered by hand. Its status follows its due date against
 * today in Nairobi. Invoices uploaded beforehand are attached with it.
 */
export function createBill(
  tenant: Tenant,
  fields: CreateBillFields,
  now: Date = new Date(),
): Effect.Effect<BillDetailView, BillError, BillDeps | Paycrest> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* checkAttachableBillFiles(tenant, fields.invoiceFileIds, null);
    const limits =
      fields.amountKes !== undefined && fields.amountKes !== null
        ? yield* activeCashOutLimits
        : null;
    const billId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const payee = yield* findPayee(tx, organizationId, fields.payeeId);
        yield* checkCategory(tx, organizationId, fields.categoryId);
        const currency = currencyForPayeeMethod(payee.method);
        const typed = typedAmount(fields);
        yield* checkCurrency(payee, currency, typed);
        yield* checkCashOutAmount(payee.method, typed?.value ?? null, limits);
        const values = {
          payeeId: fields.payeeId,
          overviewHeading:
            fields.overviewHeading ?? defaultBillHeading(payee.kind),
          categoryId: fields.categoryId,
          variable: fields.variable,
          ...amountColumns(currency, typed?.value ?? null),
          reference: fields.reference ?? null,
          notes: fields.notes ?? null,
          dueOn: fields.dueOn,
          status: scheduledStatus(fields.dueOn, nairobiDate(now)),
        };
        const [created] = yield* query(() =>
          tx
            .insert(bills)
            .values({ organizationId, ...values })
            .returning({ id: bills.id }),
        );
        if (!created)
          return yield* Effect.dieMessage("bill insert wrote no row");
        yield* attachBillFiles(
          tx,
          tenant,
          created.id,
          fields.invoiceFileIds,
          "invoice",
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "bill.created",
          entity: { type: "bill", id: created.id },
          after: { ...values, invoiceFileIds: fields.invoiceFileIds },
        });
        return created.id;
      }),
    );
    return yield* getBill(tenant, billId);
  });
}

const CHANGEABLE = [
  "payeeId",
  "currency",
  "amountKes",
  "amountUsdc",
  "dueOn",
  "status",
  "overviewHeading",
  "categoryId",
  "reference",
  "notes",
  "adjustmentReason",
] as const satisfies readonly (keyof BillRow)[];

type BillChanges = Partial<Pick<BillRow, (typeof CHANGEABLE)[number]>>;

/** The fields that differ, as they were and as they'll be, for the audit log. */
function diff(
  row: BillRow,
  next: BillChanges,
): { before: BillChanges; after: BillChanges } {
  const before: BillChanges = {};
  const after: BillChanges = {};
  const compare = <K extends keyof BillChanges>(key: K) => {
    const value = next[key];
    if (value !== undefined && value !== row[key]) {
      before[key] = row[key];
      after[key] = value;
    }
  };
  CHANGEABLE.forEach(compare);
  return { before, after };
}

/**
 * Changes an unpaid bill. Changing a fixed amount needs a reason, kept on
 * the bill and in the audit log; a variable bill's amount is entered (or
 * corrected) without one. A new due date resets the dated status.
 *
 * The amount is in the payee's currency (spec §6.19). A new payee paid in
 * the other currency, or a payee whose method changed since, needs the
 * amount again in theirs: a fixed bill's in the same request.
 */
export function updateBill(
  tenant: Tenant,
  billId: string,
  changes: UpdateBillFields,
  now: Date = new Date(),
): Effect.Effect<BillDetailView, BillError, BillDeps | Paycrest> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const limits =
      (changes.amountKes !== undefined && changes.amountKes !== null) ||
      changes.payeeId !== undefined
        ? yield* activeCashOutLimits
        : null;
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockUnpaidBill(tx, organizationId, billId);

        const payeeChanged =
          changes.payeeId !== undefined && changes.payeeId !== row.payeeId;
        const payee =
          payeeChanged && changes.payeeId !== undefined
            ? yield* findPayee(tx, organizationId, changes.payeeId)
            : yield* payeeOfBill(tx, row);
        const currency = currencyForPayeeMethod(payee.method);
        const typed = typedAmount(changes);
        yield* checkCurrency(payee, currency, typed);
        const switching = currency !== row.currency;
        const current = currency === "usd" ? row.amountUsdc : row.amountKes;
        if (typed?.value === null && !row.variable) {
          return yield* Effect.fail(
            new BadRequest({ message: "A fixed bill needs an amount." }),
          );
        }
        if (switching && typed === undefined && !row.variable) {
          return yield* Effect.fail(
            new BadRequest({
              message: `${payee.name} is paid in ${currency === "usd" ? "USDC" : "KES"}, so enter this bill's amount in ${CURRENCY_NAMES[currency]}.`,
            }),
          );
        }
        const amounts = amountColumns(
          currency,
          typed !== undefined ? typed.value : switching ? null : current,
        );
        const amountChanged =
          amounts.amountKes !== row.amountKes ||
          amounts.amountUsdc !== row.amountUsdc;
        if (amountChanged && !row.variable && !changes.adjustmentReason) {
          return yield* Effect.fail(
            new BadRequest({ message: "Say why the amount changed." }),
          );
        }
        if (changes.adjustmentReason !== undefined && !amountChanged) {
          return yield* Effect.fail(
            new BadRequest({
              message: "Only give a reason when you change the amount.",
            }),
          );
        }
        if (amountChanged || payeeChanged) {
          yield* checkCashOutAmount(payee.method, amounts.amountKes, limits);
        }
        if (
          changes.categoryId !== undefined &&
          changes.categoryId !== row.categoryId
        ) {
          yield* checkCategory(tx, organizationId, changes.categoryId);
        }
        const dueOn = changes.dueOn ?? row.dueOn;

        const { before, after } = diff(row, {
          payeeId: changes.payeeId,
          ...amounts,
          dueOn: changes.dueOn,
          status: followsDueDate(row.status)
            ? scheduledStatus(dueOn, nairobiDate(now))
            : undefined,
          overviewHeading: changes.overviewHeading,
          categoryId: changes.categoryId,
          reference: changes.reference,
          notes: changes.notes,
          adjustmentReason: changes.adjustmentReason,
        });
        if (Object.keys(after).length === 0) return;

        yield* query(() =>
          tx.update(bills).set(after).where(eq(bills.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "bill.updated",
          entity: { type: "bill", id: row.id },
          before,
          after,
        });
      }),
    );
    return yield* getBill(tenant, billId);
  });
}

/** Adds uploaded invoices to a bill, whatever its status: they're records, not money. */
export function attachBillInvoices(
  tenant: Tenant,
  billId: string,
  receiptFileIds: readonly string[],
): Effect.Effect<BillDetailView, BillError, BillDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* checkAttachableBillFiles(tenant, receiptFileIds, billId);
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockBill(tx, organizationId, billId);
        const attached = yield* attachBillFiles(
          tx,
          tenant,
          row.id,
          receiptFileIds,
          "invoice",
        );
        if (attached.length === 0) return;
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "bill.files_attached",
          entity: { type: "bill", id: row.id },
          after: { role: "invoice", receiptFileIds: attached },
        });
      }),
    );
    return yield* getBill(tenant, billId);
  });
}

/**
 * The active cash-out provider's KES rate now, when the bill is in USD: its
 * company spending record is in KES at the rate of the day it's recorded
 * (spec §6.19), as the payout engine values USDC in KES. Asked before the
 * bill is locked, so no lock waits on the provider.
 */
function rateForUsdBill(
  tenant: Tenant,
  billId: string,
): Effect.Effect<
  string | null,
  ServiceUnavailable | DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const [bill] = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({ currency: bills.currency })
          .from(bills)
          .where(
            and(
              eq(bills.organizationId, tenant.organizationId),
              eq(bills.id, billId),
            ),
          ),
      ),
    );
    if (bill?.currency !== "usd") return null;
    return yield* activeKesRate().pipe(
      Effect.catchTags({
        PaycrestError: () => Effect.fail(rateUnavailable),
        PretiumError: () => Effect.fail(rateUnavailable),
      }),
    );
  });
}

/**
 * The admin paid the bill some other way, e.g. by card or from the bank
 * (spec §6.20): records who, the day it was paid, an optional note and
 * proof. The bill needs its amount first. Company spending (T41) records
 * the matching spending entry in this same transaction, in KES: a USD
 * bill's at the active cash-out provider's rate today. The bill, not that entry, is queued for
 * Zoho Books (T44), so the payment is posted once.
 */
export function markBillPaidOutside(
  tenant: Tenant,
  billId: string,
  fields: MarkBillPaidOutsideFields,
  now: Date = new Date(),
): Effect.Effect<BillDetailView, BillError, BillDeps | Paycrest | Pretium> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    if (fields.paidOn > nairobiDate(now)) {
      return yield* Effect.fail(futurePayment);
    }
    yield* checkAttachableBillFiles(tenant, fields.receiptFileIds, billId);
    const rate = yield* rateForUsdBill(tenant, billId);
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockUnpaidBill(tx, organizationId, billId);
        const amount = billAmountOf(row);
        if (amount === null) return yield* Effect.fail(noAmount);
        if (amount.currency === "usd" && rate === null) {
          return yield* Effect.fail(changedMeanwhile);
        }
        const spendingKes =
          amount.currency === "kes"
            ? amount.amountKes
            : kesCentsFor(amount.amountUsdc, rate ?? "0");
        const [updated] = yield* query(() =>
          tx
            .update(bills)
            .set({
              status: "paid_outside",
              paidOn: fields.paidOn,
              paidAt: sql`now()`,
              markedPaidBy: tenant.userId,
              paidOutsideNote: fields.note ?? null,
            })
            .where(eq(bills.id, row.id))
            .returning({ paidAt: bills.paidAt }),
        );
        const proofFileIds = yield* attachBillFiles(
          tx,
          tenant,
          row.id,
          fields.receiptFileIds,
          "proof",
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "bill.marked_paid_outside",
          entity: { type: "bill", id: row.id },
          before: { status: row.status },
          after: {
            status: "paid_outside",
            currency: row.currency,
            amountKes: row.amountKes,
            ...(amount.currency === "usd" && {
              amountUsdc: amount.amountUsdc,
              kesEquivalent: spendingKes,
              rate,
            }),
            paidOn: fields.paidOn,
            paidAt: updated?.paidAt ?? null,
            markedPaidBy: tenant.userId,
            note: fields.note ?? null,
            proofFileIds,
          },
        });
        yield* recordBillSpending(
          tx,
          tenant,
          { ...row, amountKes: spendingKes },
          {
            paidOn: fields.paidOn,
            note: fields.note ?? null,
            paidFromAccountId: fields.paidFromAccountId ?? null,
          },
        );
        yield* enqueuePaidBill(tx, organizationId, row.id);
        yield* onRecurringBillSettled(tx, row, now);
      }),
    );
    return yield* getBill(tenant, billId);
  });
}

/** The bill won't be paid, e.g. a cancelled subscription. */
export function cancelBill(
  tenant: Tenant,
  billId: string,
  reason: string,
  now: Date = new Date(),
): Effect.Effect<BillDetailView, BillError, BillDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockUnpaidBill(tx, organizationId, billId);
        const [updated] = yield* query(() =>
          tx
            .update(bills)
            .set({
              status: "cancelled",
              cancelledReason: reason,
              cancelledBy: tenant.userId,
              cancelledAt: sql`now()`,
            })
            .where(eq(bills.id, row.id))
            .returning({ cancelledAt: bills.cancelledAt }),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "bill.cancelled",
          entity: { type: "bill", id: row.id },
          before: { status: row.status },
          after: {
            status: "cancelled",
            reason,
            cancelledBy: tenant.userId,
            cancelledAt: updated?.cancelledAt ?? null,
          },
        });
        yield* onRecurringBillSettled(tx, row, now);
      }),
    );
    return yield* getBill(tenant, billId);
  });
}
