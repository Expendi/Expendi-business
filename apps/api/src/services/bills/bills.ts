import type { SQL } from "drizzle-orm";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";

import type {
  BillStatus,
  CreateBillFields,
  MarkBillPaidOutsideFields,
  OverviewHeading,
  PayeeKind,
  PayeeMethod,
  UpdateBillFields,
} from "@expendi-business/shared";
import {
  DATED_BILL_STATUSES,
  defaultBillHeading,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BillRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { FileStorage } from "../storage/file-storage.js";
import type { BillFileView } from "./files.js";
import {
  bills,
  categories,
  payees,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { recordBillSpending } from "../expenses/company.js";
import { onRecurringBillSettled } from "../recurring/next-bill.js";
import {
  attachBillFiles,
  billFileLinks,
  checkAttachableBillFiles,
  readBillFiles,
} from "./files.js";
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
  readonly amountKes: bigint | null;
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
  readonly fileCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BillDetailView extends BillView {
  readonly files: readonly BillFileView[];
}

export interface BillFilters {
  readonly status?: readonly BillStatus[] | undefined;
  readonly heading?: OverviewHeading | undefined;
  readonly payeeId?: string | undefined;
  readonly dueFrom?: string | undefined;
  readonly dueTo?: string | undefined;
  readonly limit: number;
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
};

const selectBills = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(billColumns)
    .from(bills)
    .innerJoin(payees, eq(payees.id, bills.payeeId))
    .innerJoin(categories, eq(categories.id, bills.categoryId))
    .leftJoin(markedBy, eq(markedBy.id, bills.markedPaidBy))
    .leftJoin(cancelledBy, eq(cancelledBy.id, bills.cancelledBy))
    .where(where);

type SelectedBill = Awaited<ReturnType<typeof selectBills>>[number];

function person(
  userId: string | null,
  name: string | null,
  email: string | null,
): BillPersonView | null {
  return userId === null || email === null ? null : { userId, name, email };
}

function toBillView(row: SelectedBill): BillView {
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
    amountKes: bill.amountKes,
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
    fileCount: row.fileCount,
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
  };
}

/** Sorted by due date, earliest first. */
export function listBills(
  tenant: Tenant,
  filters: BillFilters,
): Effect.Effect<BillView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectBills(
        tx,
        and(
          eq(bills.organizationId, tenant.organizationId),
          filters.status === undefined
            ? undefined
            : inArray(bills.status, [...filters.status]),
          filters.heading === undefined
            ? undefined
            : eq(bills.overviewHeading, filters.heading),
          filters.payeeId === undefined
            ? undefined
            : eq(bills.payeeId, filters.payeeId),
          filters.dueFrom === undefined
            ? undefined
            : gte(bills.dueOn, filters.dueFrom),
          filters.dueTo === undefined
            ? undefined
            : lte(bills.dueOn, filters.dueTo),
        ),
      )
        .orderBy(asc(bills.dueOn), asc(bills.createdAt), asc(bills.id))
        .limit(filters.limit),
    ).pipe(Effect.map((rows) => rows.map(toBillView))),
  );
}

/** A bill with short-lived links to its invoice and any proof of payment. */
export function getBill(
  tenant: Tenant,
  billId: string,
): Effect.Effect<
  BillDetailView,
  NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const { row, files } = yield* withScope(tenant, (tx) =>
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
        const files = yield* readBillFiles(tx, tenant.organizationId, billId);
        return { row, files };
      }),
    );
    return { ...toBillView(row), files: yield* billFileLinks(files) };
  });
}

// ── Checks ───────────────────────────────────────────────────────────────

/** An archived payee keeps its bills but can't be given new ones. */
function findPayee(
  tx: Transaction,
  organizationId: string,
  payeeId: string,
): Effect.Effect<{ readonly kind: PayeeKind }, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select({ kind: payees.kind, archived: payees.archived })
      .from(payees)
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
): Effect.Effect<BillDetailView, BillError, BillDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* checkAttachableBillFiles(tenant, fields.invoiceFileIds, null);
    const billId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const payee = yield* findPayee(tx, organizationId, fields.payeeId);
        yield* checkCategory(tx, organizationId, fields.categoryId);
        const values = {
          payeeId: fields.payeeId,
          overviewHeading:
            fields.overviewHeading ?? defaultBillHeading(payee.kind),
          categoryId: fields.categoryId,
          variable: fields.variable,
          amountKes: fields.amountKes ?? null,
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
  "amountKes",
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
 */
export function updateBill(
  tenant: Tenant,
  billId: string,
  changes: UpdateBillFields,
  now: Date = new Date(),
): Effect.Effect<BillDetailView, BillError, BillDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockUnpaidBill(tx, organizationId, billId);

        const amountChanged =
          changes.amountKes !== undefined &&
          changes.amountKes !== row.amountKes;
        if (changes.amountKes === null && !row.variable) {
          return yield* Effect.fail(
            new BadRequest({ message: "A fixed bill needs an amount." }),
          );
        }
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
        if (changes.payeeId !== undefined && changes.payeeId !== row.payeeId) {
          yield* findPayee(tx, organizationId, changes.payeeId);
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
          amountKes: changes.amountKes,
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
 * The admin paid the bill some other way, e.g. by card or from the bank
 * (spec §6.20): records who, the day it was paid, an optional note and
 * proof. The bill needs its amount first. Company spending (T41) records
 * the matching spending entry in this same transaction.
 */
export function markBillPaidOutside(
  tenant: Tenant,
  billId: string,
  fields: MarkBillPaidOutsideFields,
  now: Date = new Date(),
): Effect.Effect<BillDetailView, BillError, BillDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    if (fields.paidOn > nairobiDate(now)) {
      return yield* Effect.fail(futurePayment);
    }
    yield* checkAttachableBillFiles(tenant, fields.receiptFileIds, billId);
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockUnpaidBill(tx, organizationId, billId);
        if (row.amountKes === null) return yield* Effect.fail(noAmount);
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
            amountKes: row.amountKes,
            paidOn: fields.paidOn,
            paidAt: updated?.paidAt ?? null,
            markedPaidBy: tenant.userId,
            note: fields.note ?? null,
            proofFileIds,
          },
        });
        yield* recordBillSpending(tx, tenant, row, {
          paidOn: fields.paidOn,
          note: fields.note ?? null,
          paidFromAccountId: fields.paidFromAccountId ?? null,
        });
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
