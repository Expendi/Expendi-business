import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  BillFileRole,
  EtimsStatus,
  ExpenseWarning,
  OverviewHeading,
  PaidFromAccountKind,
  ReceiptFileKind,
  RecordCompanySpendingFields,
  UpdateCompanySpendingFields,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BillRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { StorageError } from "../storage/file-storage.js";
import { violatedUniqueConstraint } from "../../db/error.js";
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
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { readBillFiles } from "../bills/files.js";
import { FileStorage } from "../storage/file-storage.js";
import { enqueueRecordedSpending } from "../zoho/enqueue.js";
import { etimsStatusFor, resolveEtims } from "./etims.js";
import { extractionsOf } from "./extraction.js";
import { findPaidFromAccount } from "./paid-from-accounts.js";
import {
  checkAttachableReceipts,
  setExpenseReceipts,
  storageFailure,
} from "./receipts.js";
import {
  checkDuplicateKeys,
  expenseWarnings,
  nairobiToday,
  readWarnings,
} from "./rules.js";
import { reconcileWithSms, smsTextAmong } from "./sms-evidence.js";

/**
 * Company spending (spec §6.23): money the company already spent outside
 * Expendi, recorded by an admin with the claim capture flow and the account
 * it was paid from. It's always `recorded`: no approval, no payout. The
 * claim rules apply (spec §6.5), except that an admin can save it without a
 * receipt by saying why, which flags it "no receipt".
 *
 * Marking a bill paid outside Expendi records it here too, in the same
 * transaction (`recordBillSpending`), linked to the bill, whose invoice and
 * proof serve as its receipts. The link is unique, so a bill only ever
 * records one entry.
 *
 * Admins only: the routes admit no one else.
 */

/** `CompanySpending` before serialisation turns bigints and dates into strings. */
export interface CompanySpendingView {
  readonly id: string;
  readonly status: "recorded";
  readonly overviewHeading: OverviewHeading;
  readonly merchant: string;
  readonly amountKes: bigint;
  readonly spentOn: string;
  readonly description: string | null;
  readonly category: { readonly id: string; readonly name: string };
  readonly paidFromAccount: {
    readonly id: string;
    readonly name: string;
    readonly kind: PaidFromAccountKind;
    readonly archived: boolean;
  } | null;
  readonly bill: {
    readonly id: string;
    readonly payee: { readonly id: string; readonly name: string };
    readonly reference: string | null;
    readonly dueOn: string;
  } | null;
  readonly mpesaCode: string | null;
  readonly etimsInvoiceNumber: string | null;
  readonly etimsSupplierPin: string | null;
  readonly etimsQrPayload: string | null;
  readonly etimsStatus: EtimsStatus;
  readonly noReceipt: boolean;
  readonly noReceiptReason: string | null;
  readonly warnings: readonly ExpenseWarning[];
  readonly receiptCount: number;
  readonly recordedBy: {
    readonly membershipId: string;
    readonly name: string | null;
    readonly email: string;
  };
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CompanySpendingReceiptView =
  | {
      readonly id: string;
      readonly kind: Exclude<ReceiptFileKind, "sms_text">;
      readonly billRole: BillFileRole | null;
      readonly contentType: string;
      readonly url: string;
      readonly expiresAt: Date;
    }
  | {
      readonly id: string;
      readonly kind: "sms_text";
      readonly billRole: null;
      readonly text: string;
    };

export interface CompanySpendingDetailView extends CompanySpendingView {
  readonly receipts: readonly CompanySpendingReceiptView[];
}

export interface CompanySpendingPageView {
  readonly spending: readonly CompanySpendingView[];
  readonly nextCursor: string | null;
}

export interface CompanySpendingFilters {
  readonly heading?: OverviewHeading | undefined;
  readonly categoryId?: string | undefined;
  readonly paidFromAccountId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

type SpendingDeps = DatabaseService | AuditLog | FileStorage;
type SpendingError =
  BadRequest | Conflict | NotFound | ServiceUnavailable | DatabaseError;

/** Company spending's heading unless the admin picks another (spec §6.23). */
export const DEFAULT_COMPANY_SPENDING_HEADING = "transactions";

const spendingNotFound = new NotFound({
  message: "That spending wasn't found.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});
const futureDate = new BadRequest({
  message: "The date can't be in the future.",
});
const badCursor = new BadRequest({ message: "That page link isn't valid." });
const needsReceiptOrReason = new BadRequest({
  message: "Add a receipt, or say why there isn't one.",
});
const reasonWithReceipt = new BadRequest({
  message: "Only give a reason when there's no receipt.",
});
const oneSmsPerSpending = new BadRequest({
  message: "Attach one M-Pesa SMS per spending.",
});
const fromABill = new Conflict({
  message:
    "This was recorded from a bill marked paid, so its amount and date stay the bill's.",
});

/**
 * spec §6.5, §6.23: receipt rules apply, but an admin can save without one
 * by giving a reason. A reason alongside a receipt is refused, so the
 * "no receipt" flag always means what it says.
 */
export function requireReceiptOrReason(
  receiptCount: number,
  reason: string | null,
): Effect.Effect<void, BadRequest> {
  if (receiptCount > 0) {
    return reason === null ? Effect.void : Effect.fail(reasonWithReceipt);
  }
  return reason === null ? Effect.fail(needsReceiptOrReason) : Effect.void;
}

/** `checkDuplicateKeys` names the earlier expense; these only answer two writes racing past it. */
const DUPLICATE_CODE_MESSAGES: Readonly<Record<string, string>> = {
  expenses_mpesa_code_unique: "This M-Pesa code is already on another expense.",
  expenses_etims_invoice_number_unique:
    "This eTIMS invoice number is already on another expense.",
};

function duplicateCodeConflict(
  error: DatabaseError,
): Effect.Effect<never, Conflict | DatabaseError> {
  const constraint = violatedUniqueConstraint(error.cause);
  const message =
    constraint === null ? undefined : DUPLICATE_CODE_MESSAGES[constraint];
  return Effect.fail(message ? new Conflict({ message }) : error);
}

function checkSpentOn(
  spentOn: string | undefined,
): Effect.Effect<void, BadRequest> {
  return spentOn !== undefined && spentOn > nairobiToday()
    ? Effect.fail(futureDate)
    : Effect.void;
}

/** An archived category can stay on spending, but can't be picked for it. */
function findCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
  { allowArchived }: { readonly allowArchived: boolean },
): Effect.Effect<
  { readonly etimsNotRequired: boolean },
  BadRequest | DatabaseError
> {
  return query(() =>
    tx
      .select({
        etimsNotRequired: categories.etimsNotRequired,
        archived: categories.archived,
      })
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
      category && (allowArchived || !category.archived)
        ? Effect.succeed(category)
        : Effect.fail(unknownCategory),
    ),
  );
}

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

const viewerOf = (tenant: Tenant) => ({
  membershipId: tenant.membershipId,
  isAdmin: tenant.role === "admin",
});

const companySpendingOf = (organizationId: string): SQL | undefined =>
  and(
    eq(expenses.organizationId, organizationId),
    eq(expenses.kind, "company"),
  );

// ── Reading ──────────────────────────────────────────────────────────────

const ownReceiptCount = sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.expenseId} = ${expenses.id})`;
const billFileCount = sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.billId} = ${expenses.billId})`;

const spendingColumns = {
  id: expenses.id,
  overviewHeading: expenses.overviewHeading,
  merchant: expenses.merchant,
  amountKes: expenses.amountKes,
  spentOn: expenses.spentOn,
  description: expenses.description,
  categoryId: categories.id,
  categoryName: categories.name,
  accountId: paidFromAccounts.id,
  accountName: paidFromAccounts.name,
  accountKind: paidFromAccounts.kind,
  accountArchived: paidFromAccounts.archived,
  billId: bills.id,
  billReference: bills.reference,
  billDueOn: bills.dueOn,
  payeeId: payees.id,
  payeeName: payees.name,
  mpesaCode: expenses.mpesaCode,
  etimsInvoiceNumber: expenses.etimsInvoiceNumber,
  etimsSupplierPin: expenses.etimsSupplierPin,
  etimsQrPayload: expenses.etimsQrPayload,
  etimsStatus: expenses.etimsStatus,
  noReceiptReason: expenses.noReceiptReason,
  warnings: expenses.warnings,
  membershipId: expenses.membershipId,
  recorderName: users.fullName,
  recorderEmail: users.email,
  receiptCount: sql<number>`${ownReceiptCount} + ${billFileCount}`,
  createdAt: expenses.createdAt,
  updatedAt: expenses.updatedAt,
  /** Microsecond precision, so paging never skips or repeats a record. */
  cursorAt: sql<string>`to_char(${expenses.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

const selectSpending = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(spendingColumns)
    .from(expenses)
    .innerJoin(categories, eq(categories.id, expenses.categoryId))
    .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(
      paidFromAccounts,
      eq(paidFromAccounts.id, expenses.paidFromAccountId),
    )
    .leftJoin(bills, eq(bills.id, expenses.billId))
    .leftJoin(payees, eq(payees.id, bills.payeeId))
    .where(where);

type SpendingRow = Awaited<ReturnType<typeof selectSpending>>[number];

function toSpendingView(row: SpendingRow): CompanySpendingView {
  return {
    id: row.id,
    status: "recorded",
    overviewHeading: row.overviewHeading,
    merchant: row.merchant,
    amountKes: row.amountKes,
    spentOn: row.spentOn,
    description: row.description,
    category: { id: row.categoryId, name: row.categoryName },
    paidFromAccount:
      row.accountId === null ||
      row.accountName === null ||
      row.accountKind === null ||
      row.accountArchived === null
        ? null
        : {
            id: row.accountId,
            name: row.accountName,
            kind: row.accountKind,
            archived: row.accountArchived,
          },
    bill:
      row.billId === null ||
      row.billDueOn === null ||
      row.payeeId === null ||
      row.payeeName === null
        ? null
        : {
            id: row.billId,
            payee: { id: row.payeeId, name: row.payeeName },
            reference: row.billReference,
            dueOn: row.billDueOn,
          },
    mpesaCode: row.mpesaCode,
    etimsInvoiceNumber: row.etimsInvoiceNumber,
    etimsSupplierPin: row.etimsSupplierPin,
    etimsQrPayload: row.etimsQrPayload,
    etimsStatus: row.etimsStatus,
    noReceipt: row.receiptCount === 0,
    noReceiptReason: row.noReceiptReason,
    warnings: readWarnings(row.warnings),
    receiptCount: row.receiptCount,
    recordedBy: {
      membershipId: row.membershipId,
      name: row.recorderName,
      email: row.recorderEmail,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const encodeCursor = (row: SpendingRow): string =>
  Buffer.from(`${row.spentOn}|${row.cursorAt}|${row.id}`, "utf8").toString(
    "base64url",
  );

function decodeCursor(cursor: string): Effect.Effect<
  {
    readonly spentOn: string;
    readonly at: string;
    readonly id: string;
  },
  BadRequest
> {
  const match = CURSOR_PATTERN.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  return match?.[1] && match[2] && match[3]
    ? Effect.succeed({ spentOn: match[1], at: match[2], id: match[3] })
    : Effect.fail(badCursor);
}

/** Latest date first, then latest recorded, a page at a time. */
export function listCompanySpending(
  tenant: Tenant,
  filters: CompanySpendingFilters,
): Effect.Effect<
  CompanySpendingPageView,
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const after =
      filters.cursor === undefined ? null : yield* decodeCursor(filters.cursor);
    const rows = yield* withScope(tenant, (tx) =>
      query(() =>
        selectSpending(
          tx,
          and(
            companySpendingOf(tenant.organizationId),
            filters.heading === undefined
              ? undefined
              : eq(expenses.overviewHeading, filters.heading),
            filters.categoryId === undefined
              ? undefined
              : eq(expenses.categoryId, filters.categoryId),
            filters.paidFromAccountId === undefined
              ? undefined
              : eq(expenses.paidFromAccountId, filters.paidFromAccountId),
            filters.from === undefined
              ? undefined
              : gte(expenses.spentOn, filters.from),
            filters.to === undefined
              ? undefined
              : lte(expenses.spentOn, filters.to),
            after === null
              ? undefined
              : sql`(${expenses.spentOn}, ${expenses.createdAt}, ${expenses.id}) < (${after.spentOn}::date, ${after.at}::timestamptz, ${after.id}::uuid)`,
          ),
        )
          .orderBy(
            desc(expenses.spentOn),
            desc(expenses.createdAt),
            desc(expenses.id),
          )
          .limit(filters.limit + 1),
      ),
    );
    const page = rows.slice(0, filters.limit);
    const last = page.at(-1);
    return {
      spending: page.map(toSpendingView),
      nextCursor:
        rows.length > filters.limit && last ? encodeCursor(last) : null,
    };
  });
}

interface StoredReceipt {
  readonly id: string;
  readonly kind: ReceiptFileKind;
  readonly billRole: BillFileRole | null;
  readonly contentType: string;
  readonly storageKey: string | null;
  readonly smsText: string | null;
}

function receiptLink(
  storage: FileStorage["Type"],
  file: StoredReceipt,
): Effect.Effect<CompanySpendingReceiptView, StorageError> {
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
}

/** One record with short-lived links to its receipts, and its bill's invoice and proof. */
export function getCompanySpending(
  tenant: Tenant,
  spendingId: string,
): Effect.Effect<
  CompanySpendingDetailView,
  NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    const { row, files } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          selectSpending(
            tx,
            and(
              companySpendingOf(tenant.organizationId),
              eq(expenses.id, spendingId),
            ),
          ).limit(1),
        );
        if (!row) return yield* Effect.fail(spendingNotFound);
        const own = yield* query(() =>
          tx
            .select({
              id: receiptFiles.id,
              kind: receiptFiles.kind,
              contentType: receiptFiles.contentType,
              storageKey: receiptFiles.storageKey,
              smsText: receiptFiles.smsText,
            })
            .from(receiptFiles)
            .where(
              and(
                eq(receiptFiles.organizationId, tenant.organizationId),
                eq(receiptFiles.expenseId, row.id),
              ),
            )
            .orderBy(asc(receiptFiles.createdAt), asc(receiptFiles.id)),
        );
        const fromBill =
          row.billId === null
            ? []
            : yield* readBillFiles(tx, tenant.organizationId, row.billId);
        const files: StoredReceipt[] = [
          ...own.map((file) => ({ ...file, billRole: null })),
          ...fromBill.map((file) => ({
            id: file.id,
            kind: file.kind,
            billRole: file.role,
            contentType: file.contentType,
            storageKey: file.storageKey,
            smsText: null,
          })),
        ];
        return { row, files };
      }),
    );
    const receipts = yield* Effect.forEach(files, (file) =>
      receiptLink(storage, file),
    ).pipe(Effect.mapError(storageFailure));
    return { ...toSpendingView(row), receipts };
  });
}

// ── Recording ────────────────────────────────────────────────────────────

/** The admin records spending already paid outside Expendi (spec §6.23). */
export function recordCompanySpending(
  tenant: Tenant,
  fields: RecordCompanySpendingFields,
): Effect.Effect<CompanySpendingDetailView, SpendingError, SpendingDeps> {
  const { organizationId } = tenant;
  const noReceiptReason = fields.noReceiptReason ?? null;
  return Effect.gen(function* () {
    yield* checkSpentOn(fields.spentOn);
    yield* requireReceiptOrReason(
      fields.receiptFileIds.length,
      noReceiptReason,
    );
    if (fields.receiptFileIds.length > 0) {
      yield* checkAttachableReceipts(tenant, fields.receiptFileIds);
    }
    const spendingId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const category = yield* findCategory(
          tx,
          organizationId,
          fields.categoryId,
          { allowArchived: false },
        );
        yield* findPaidFromAccount(
          tx,
          organizationId,
          fields.paidFromAccountId,
          {
            allowArchived: false,
          },
        );
        const mpesaCode = yield* reconcileWithSms(
          { mpesaCode: fields.mpesaCode ?? null, amountKes: fields.amountKes },
          yield* smsTextAmong(tx, organizationId, {
            receiptFileIds: fields.receiptFileIds,
          }),
        );
        const values = {
          overviewHeading:
            fields.overviewHeading ?? DEFAULT_COMPANY_SPENDING_HEADING,
          merchant: fields.merchant,
          amountKes: fields.amountKes,
          spentOn: fields.spentOn,
          categoryId: fields.categoryId,
          description: fields.description,
          paidFromAccountId: fields.paidFromAccountId,
          noReceiptReason,
          mpesaCode,
          ...(yield* resolveEtims(
            {
              etimsQrPayload: fields.etimsQrPayload ?? null,
              etimsInvoiceNumber: fields.etimsInvoiceNumber ?? null,
              etimsSupplierPin: fields.etimsSupplierPin ?? null,
            },
            category,
          )),
        };
        yield* checkDuplicateKeys(
          tx,
          organizationId,
          values,
          viewerOf(tenant),
          null,
        );
        const warnings = yield* expenseWarnings(tx, {
          id: null,
          organizationId,
          membershipId: tenant.membershipId,
          amountKes: values.amountKes,
          spentOn: values.spentOn,
        });
        const extraction = yield* extractionsOf(
          tx,
          organizationId,
          fields.receiptFileIds,
        );
        const [created] = yield* query(() =>
          tx
            .insert(expenses)
            .values({
              organizationId,
              membershipId: tenant.membershipId,
              kind: "company",
              source: "app",
              status: "recorded",
              ...values,
              warnings,
              extraction,
            })
            .returning({ id: expenses.id }),
        );
        if (!created) {
          return yield* Effect.dieMessage(
            "company spending insert wrote no row",
          );
        }
        yield* setExpenseReceipts(
          tx,
          tenant,
          created.id,
          fields.receiptFileIds,
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "expense.recorded",
          entity: { type: "expense", id: created.id },
          after: {
            kind: "company",
            status: "recorded",
            ...values,
            warnings,
            receiptFileIds: fields.receiptFileIds,
          },
        });
        yield* enqueueRecordedSpending(tx, organizationId, created.id);
        return created.id;
      }),
    ).pipe(Effect.catchTag("DatabaseError", duplicateCodeConflict));
    return yield* getCompanySpending(tenant, spendingId);
  });
}

const BILL_LINK_UNIQUE = "expenses_bill_id_unique";

/** What marking a bill paid outside Expendi said about the payment. */
export interface OutsidePayment {
  readonly paidOn: string;
  readonly note: string | null;
  /** Null when the admin didn't say: "not specified" until they edit it. */
  readonly paidFromAccountId: string | null;
}

/** "Bill INV-0042: paid by card", or "Bill paid outside Expendi". */
function billSpendingDescription(
  reference: string | null,
  note: string | null,
): string {
  const bill = reference === null ? "Bill" : `Bill ${reference}`;
  return note === null ? `${bill} paid outside Expendi` : `${bill}: ${note}`;
}

function existingBillSpending(
  tx: Transaction,
  organizationId: string,
  billId: string,
): Effect.Effect<string, DatabaseError> {
  return query(() =>
    tx
      .select({ id: expenses.id })
      .from(expenses)
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          eq(expenses.billId, billId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([row]) =>
      row
        ? Effect.succeed(row.id)
        : Effect.dieMessage(`bill ${billId} clashed but has no spending`),
    ),
  );
}

/**
 * A bill marked paid outside Expendi becomes company spending (spec
 * §6.20, §6.23), inside the transaction that marks it: the bill's amount,
 * payee, heading and category, the day it was paid, and a link back to
 * the bill, whose invoice and proof are its receipts. Returns the
 * spending's ID. Exactly one per bill: a second attempt finds the first
 * through the unique link and records nothing.
 */
export function recordBillSpending(
  tx: Transaction,
  tenant: Tenant,
  bill: Pick<
    BillRow,
    | "id"
    | "organizationId"
    | "payeeId"
    | "overviewHeading"
    | "categoryId"
    | "amountKes"
    | "reference"
  >,
  payment: OutsidePayment,
): Effect.Effect<string, BadRequest | DatabaseError, AuditLog> {
  const { organizationId } = bill;
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const amountKes = bill.amountKes;
    if (amountKes === null) {
      return yield* Effect.dieMessage(
        `bill ${bill.id} has no amount to record`,
      );
    }
    if (payment.paidFromAccountId !== null) {
      yield* findPaidFromAccount(
        tx,
        organizationId,
        payment.paidFromAccountId,
        {
          allowArchived: false,
        },
      );
    }
    const [source] = yield* query(() =>
      tx
        .select({
          payeeName: payees.name,
          etimsNotRequired: categories.etimsNotRequired,
        })
        .from(payees)
        .innerJoin(categories, eq(categories.id, bill.categoryId))
        .where(
          and(
            eq(payees.organizationId, organizationId),
            eq(payees.id, bill.payeeId),
          ),
        )
        .limit(1),
    );
    if (!source) {
      return yield* Effect.dieMessage(`bill ${bill.id} lost its payee`);
    }
    const values = {
      overviewHeading: bill.overviewHeading,
      merchant: source.payeeName,
      amountKes,
      spentOn: payment.paidOn,
      categoryId: bill.categoryId,
      description: billSpendingDescription(bill.reference, payment.note),
      paidFromAccountId: payment.paidFromAccountId,
      billId: bill.id,
      etimsStatus: etimsStatusFor(null, source),
    };
    const warnings = yield* expenseWarnings(tx, {
      id: null,
      organizationId,
      membershipId: tenant.membershipId,
      amountKes,
      spentOn: payment.paidOn,
    });
    const created = yield* query(() =>
      // A savepoint, so a clash on the bill link rolls back only this insert.
      tx.transaction((savepoint) =>
        savepoint
          .insert(expenses)
          .values({
            organizationId,
            membershipId: tenant.membershipId,
            kind: "company",
            source: "app",
            status: "recorded",
            ...values,
            warnings,
          })
          .returning({ id: expenses.id }),
      ),
    ).pipe(
      Effect.map(([row]) => row?.id ?? null),
      Effect.catchTag("DatabaseError", (error) =>
        violatedUniqueConstraint(error.cause) === BILL_LINK_UNIQUE
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    );
    if (created === null) {
      return yield* existingBillSpending(tx, organizationId, bill.id);
    }
    yield* audit.record(tx, {
      actor: userActor(tenant),
      organizationId,
      action: "expense.recorded",
      entity: { type: "expense", id: created },
      after: { kind: "company", status: "recorded", ...values, warnings },
    });
    return created;
  });
}

// ── Editing ──────────────────────────────────────────────────────────────

function lockSpending(tx: Transaction, organizationId: string, id: string) {
  return query(() =>
    tx
      .select({
        membershipId: expenses.membershipId,
        billId: expenses.billId,
        overviewHeading: expenses.overviewHeading,
        merchant: expenses.merchant,
        amountKes: expenses.amountKes,
        spentOn: expenses.spentOn,
        categoryId: expenses.categoryId,
        description: expenses.description,
        paidFromAccountId: expenses.paidFromAccountId,
        noReceiptReason: expenses.noReceiptReason,
        mpesaCode: expenses.mpesaCode,
        etimsInvoiceNumber: expenses.etimsInvoiceNumber,
        etimsSupplierPin: expenses.etimsSupplierPin,
        etimsQrPayload: expenses.etimsQrPayload,
        etimsStatus: expenses.etimsStatus,
        warnings: expenses.warnings,
      })
      .from(expenses)
      .where(and(companySpendingOf(organizationId), eq(expenses.id, id)))
      .for("update"),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(spendingNotFound),
    ),
  );
}

type EditableField =
  | "overviewHeading"
  | "merchant"
  | "amountKes"
  | "spentOn"
  | "categoryId"
  | "description"
  | "paidFromAccountId"
  | "noReceiptReason"
  | "mpesaCode"
  | "etimsInvoiceNumber"
  | "etimsSupplierPin"
  | "etimsQrPayload"
  | "etimsStatus";

type Editable = Readonly<Record<EditableField, unknown>>;

function changedFields(before: Editable, after: Editable): EditableField[] {
  return (Object.keys(after) as EditableField[]).filter(
    (field) => before[field] !== after[field],
  );
}

const pick = (values: Editable, fields: readonly EditableField[]) =>
  Object.fromEntries(fields.map((field) => [field, values[field]]));

/** A field left out of an edit keeps its value; null clears it. */
function unlessLeftOut<T>(change: T | undefined, current: T): T {
  if (change === undefined) return current;
  return change;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

const sameWarnings = (
  a: readonly ExpenseWarning[],
  b: readonly ExpenseWarning[],
): boolean => JSON.stringify(a) === JSON.stringify(b);

interface ReceiptTally {
  readonly own: number;
  readonly sms: number;
  readonly onBill: number;
}

function tallyReceipts(
  tx: Transaction,
  organizationId: string,
  spending: { readonly id: string; readonly billId: string | null },
): Effect.Effect<ReceiptTally, DatabaseError> {
  return query(() =>
    tx
      .select({
        own: sql<number>`count(*) FILTER (WHERE ${receiptFiles.expenseId} = ${spending.id})::int`,
        sms: sql<number>`count(*) FILTER (WHERE ${receiptFiles.expenseId} = ${spending.id} AND ${receiptFiles.kind} = 'sms_text')::int`,
        onBill:
          spending.billId === null
            ? sql<number>`0`
            : sql<number>`count(*) FILTER (WHERE ${receiptFiles.billId} = ${spending.billId})::int`,
      })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          or(
            eq(receiptFiles.expenseId, spending.id),
            spending.billId === null
              ? undefined
              : eq(receiptFiles.billId, spending.billId),
          ),
        ),
      ),
  ).pipe(Effect.map(([tally]) => tally ?? { own: 0, sms: 0, onBill: 0 }));
}

/** The files on the spending now, so an edit keeps them whoever uploaded them. */
function currentReceiptIds(
  tenant: Tenant,
  spendingId: string,
): Effect.Effect<readonly string[], NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      yield* lockSpending(tx, tenant.organizationId, spendingId);
      const files = yield* query(() =>
        tx
          .select({ id: receiptFiles.id })
          .from(receiptFiles)
          .where(
            and(
              eq(receiptFiles.organizationId, tenant.organizationId),
              eq(receiptFiles.expenseId, spendingId),
            ),
          ),
      );
      return files.map((file) => file.id);
    }),
  );
}

/**
 * Any admin's edit of company spending, which stays `recorded`. A field
 * left out stays; null clears an optional one. The rules run again, and
 * the audit entry keeps only what changed, before and after. Spending
 * recorded from a bill keeps the bill's amount and date, and needs no
 * reason when it has no receipt: proof is optional on a paid bill
 * (spec §6.20), so it's simply flagged.
 */
export function updateCompanySpending(
  tenant: Tenant,
  spendingId: string,
  changes: UpdateCompanySpendingFields,
): Effect.Effect<CompanySpendingDetailView, SpendingError, SpendingDeps> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* checkSpentOn(changes.spentOn);
    const onSpending = yield* currentReceiptIds(tenant, spendingId);
    if (changes.receiptFileIds) {
      const added = changes.receiptFileIds.filter(
        (id) => !onSpending.includes(id),
      );
      if (added.length > 0) yield* checkAttachableReceipts(tenant, added);
    }

    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockSpending(tx, organizationId, spendingId);
        if (
          row.billId !== null &&
          ((changes.amountKes !== undefined &&
            changes.amountKes !== row.amountKes) ||
            (changes.spentOn !== undefined && changes.spentOn !== row.spentOn))
        ) {
          return yield* Effect.fail(fromABill);
        }
        const categoryId = changes.categoryId ?? row.categoryId;
        const category = yield* findCategory(tx, organizationId, categoryId, {
          allowArchived: categoryId === row.categoryId,
        });
        const paidFromAccountId =
          changes.paidFromAccountId ?? row.paidFromAccountId;
        if (
          paidFromAccountId !== null &&
          paidFromAccountId !== row.paidFromAccountId
        ) {
          yield* findPaidFromAccount(tx, organizationId, paidFromAccountId, {
            allowArchived: false,
          });
        }
        const receipts = changes.receiptFileIds
          ? {
              before: yield* setExpenseReceipts(
                tx,
                tenant,
                spendingId,
                changes.receiptFileIds,
              ),
              after: changes.receiptFileIds,
            }
          : null;
        const tally = yield* tallyReceipts(tx, organizationId, {
          id: spendingId,
          billId: row.billId,
        });
        if (tally.sms > 1) return yield* Effect.fail(oneSmsPerSpending);
        const receiptCount = tally.own + tally.onBill;
        const noReceiptReason =
          changes.noReceiptReason !== undefined
            ? changes.noReceiptReason
            : receiptCount > 0
              ? null
              : row.noReceiptReason;
        if (row.billId === null || receiptCount > 0) {
          yield* requireReceiptOrReason(receiptCount, noReceiptReason);
        }

        const amountKes = changes.amountKes ?? row.amountKes;
        const mpesaCode = yield* reconcileWithSms(
          {
            mpesaCode: unlessLeftOut(changes.mpesaCode, row.mpesaCode),
            amountKes,
          },
          yield* smsTextAmong(tx, organizationId, { expenseId: spendingId }),
        );
        const next = {
          overviewHeading: changes.overviewHeading ?? row.overviewHeading,
          merchant: changes.merchant ?? row.merchant,
          amountKes,
          spentOn: changes.spentOn ?? row.spentOn,
          categoryId,
          description: changes.description ?? row.description,
          paidFromAccountId,
          noReceiptReason,
          mpesaCode,
          ...(yield* resolveEtims(
            {
              etimsQrPayload: unlessLeftOut(
                changes.etimsQrPayload,
                row.etimsQrPayload,
              ),
              etimsInvoiceNumber: unlessLeftOut(
                changes.etimsInvoiceNumber,
                row.etimsInvoiceNumber,
              ),
              etimsSupplierPin: unlessLeftOut(
                changes.etimsSupplierPin,
                row.etimsSupplierPin,
              ),
            },
            category,
          )),
        };
        yield* checkDuplicateKeys(
          tx,
          organizationId,
          next,
          viewerOf(tenant),
          spendingId,
        );
        const warnings = yield* expenseWarnings(tx, {
          id: spendingId,
          organizationId,
          membershipId: row.membershipId,
          amountKes: next.amountKes,
          spentOn: next.spentOn,
        });
        const previousWarnings = readWarnings(row.warnings);
        const warningsChanged = !sameWarnings(previousWarnings, warnings);
        const receiptsChanged =
          receipts !== null && !sameSet(receipts.before, receipts.after);
        const changed = changedFields(row, next);
        if (changed.length === 0 && !receiptsChanged) {
          if (warningsChanged) {
            yield* query(() =>
              tx
                .update(expenses)
                .set({ warnings })
                .where(eq(expenses.id, spendingId)),
            );
          }
          return;
        }
        const extraction = receiptsChanged
          ? yield* extractionsOf(tx, organizationId, receipts.after)
          : null;
        yield* query(() =>
          tx
            .update(expenses)
            .set({
              ...next,
              ...(receiptsChanged && { extraction }),
              warnings,
            })
            .where(eq(expenses.id, spendingId)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "expense.edited",
          entity: { type: "expense", id: spendingId },
          before: {
            ...pick(row, changed),
            ...(receiptsChanged && { receiptFileIds: receipts.before }),
            ...(warningsChanged && { warnings: previousWarnings }),
          },
          after: {
            ...pick(next, changed),
            ...(receiptsChanged && { receiptFileIds: receipts.after }),
            ...(warningsChanged && { warnings }),
          },
        });
      }),
    ).pipe(Effect.catchTag("DatabaseError", duplicateCodeConflict));
    return yield* getCompanySpending(tenant, spendingId);
  });
}
