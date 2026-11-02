import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  EtimsStatus,
  ExpenseStatus,
  ExpenseWarning,
  ReceiptFileKind,
  SubmitClaimFields,
  UpdateClaimFields,
} from "@expendi-business/shared";
import {
  EDITABLE_CLAIM_STATUSES,
  readsWholeCompany,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { StorageError } from "../storage/file-storage.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import {
  categories,
  expenses,
  memberships,
  payouts,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { notify } from "../notification/notify.js";
import { FileStorage } from "../storage/file-storage.js";
import { resolveEtims } from "./etims.js";
import { extractionsOf } from "./extraction.js";
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
  requireEvidence,
} from "./rules.js";
import { reconcileWithSms, smsTextAmong } from "./sms-evidence.js";

/**
 * Staff claims (spec §5, §6.3): submitting, listing, the owner's edits while
 * a claim is `submitted` or `rejected` (editing a rejected claim resubmits
 * it), and an admin rejecting it. Approve & pay is `claim-approval.ts`.
 */

/** `Claim` before serialisation turns bigints and dates into strings. */
export interface ClaimView {
  readonly id: string;
  readonly status: ExpenseStatus;
  readonly merchant: string;
  readonly amountKes: bigint;
  readonly spentOn: string;
  readonly description: string | null;
  readonly category: { readonly id: string; readonly name: string };
  readonly mpesaCode: string | null;
  readonly etimsInvoiceNumber: string | null;
  readonly etimsSupplierPin: string | null;
  readonly etimsQrPayload: string | null;
  readonly etimsStatus: EtimsStatus;
  readonly rejectedReason: string | null;
  readonly submittedBy: {
    readonly membershipId: string;
    readonly name: string | null;
    readonly email: string;
    readonly payoutPhoneConfirmed: boolean;
  };
  readonly approvedAt: Date | null;
  readonly selfApproved: boolean;
  readonly paidAt: Date | null;
  readonly canEdit: boolean;
  /** Admins only (spec §6.5). */
  readonly warnings: readonly ExpenseWarning[];
  readonly receiptCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ClaimReceiptView =
  | {
      readonly id: string;
      readonly kind: Exclude<ReceiptFileKind, "sms_text">;
      readonly contentType: string;
      readonly url: string;
      readonly expiresAt: Date;
    }
  | { readonly id: string; readonly kind: "sms_text"; readonly text: string };

export interface ClaimDetailView extends ClaimView {
  readonly receipts: readonly ClaimReceiptView[];
  /** Admins only (spec §6.8): the latest payment, to see why it failed. */
  readonly payout: {
    readonly id: string;
    readonly status: Payout["status"];
    readonly failureReason: string | null;
  } | null;
}

export interface ClaimsPageView {
  readonly claims: readonly ClaimView[];
  readonly nextCursor: string | null;
}

const claimNotFound = new NotFound({ message: "Claim not found" });
const notYourClaim = new Forbidden({
  message: "Only the person who submitted a claim can change it.",
});
const notEditable = new Conflict({
  message: "This claim can't be changed after it's approved.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});
const futureDate = new BadRequest({
  message: "The date can't be in the future.",
});
const badCursor = new BadRequest({ message: "That page link isn't valid." });

/**
 * spec §6.5. `checkDuplicateKeys` names the earlier expense; these only
 * answer two writes racing past it.
 */
const DUPLICATE_CODE_MESSAGES: Readonly<Record<string, string>> = {
  expenses_mpesa_code_unique: "This M-Pesa code is already on another claim.",
  expenses_etims_invoice_number_unique:
    "This eTIMS invoice number is already on another claim.",
};

function duplicateCodeConflict(
  error: DatabaseError,
): Effect.Effect<never, Conflict | DatabaseError> {
  const constraint = violatedUniqueConstraint(error.cause);
  const message =
    constraint === null ? undefined : DUPLICATE_CODE_MESSAGES[constraint];
  return Effect.fail(message ? new Conflict({ message }) : error);
}

/**
 * Employees see only their own claims; admins and accountants see all of the
 * company's (spec §4).
 */
function visibleClaims(tenant: Tenant): SQL | undefined {
  return and(
    eq(expenses.organizationId, tenant.organizationId),
    eq(expenses.kind, "claim"),
    readsWholeCompany(tenant.role)
      ? undefined
      : eq(expenses.membershipId, tenant.membershipId),
  );
}

const isEditable = (status: ExpenseStatus): boolean =>
  (EDITABLE_CLAIM_STATUSES as readonly ExpenseStatus[]).includes(status);

function checkSpentOn(
  spentOn: string | undefined,
): Effect.Effect<void, BadRequest> {
  return spentOn !== undefined && spentOn > nairobiToday()
    ? Effect.fail(futureDate)
    : Effect.void;
}

/** An archived category can stay on a claim, but can't be picked for one. */
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

const claimColumns = {
  id: expenses.id,
  status: expenses.status,
  merchant: expenses.merchant,
  amountKes: expenses.amountKes,
  spentOn: expenses.spentOn,
  description: expenses.description,
  categoryId: categories.id,
  categoryName: categories.name,
  mpesaCode: expenses.mpesaCode,
  etimsInvoiceNumber: expenses.etimsInvoiceNumber,
  etimsSupplierPin: expenses.etimsSupplierPin,
  etimsQrPayload: expenses.etimsQrPayload,
  etimsStatus: expenses.etimsStatus,
  rejectedReason: expenses.rejectedReason,
  membershipId: expenses.membershipId,
  warnings: expenses.warnings,
  submitterName: users.fullName,
  submitterEmail: users.email,
  submitterPhoneConfirmed: sql<boolean>`${users.phone} IS NOT NULL`,
  approvedAt: expenses.approvedAt,
  selfApproved: expenses.selfApproved,
  paidAt: expenses.paidAt,
  payoutId: expenses.payoutId,
  receiptCount: sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.expenseId} = ${expenses.id})`,
  createdAt: expenses.createdAt,
  updatedAt: expenses.updatedAt,
  /** Microsecond precision, so paging never skips or repeats a claim. */
  cursorAt: sql<string>`to_char(${expenses.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

const selectClaims = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(claimColumns)
    .from(expenses)
    .innerJoin(categories, eq(categories.id, expenses.categoryId))
    .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(where);

type ClaimRow = Awaited<ReturnType<typeof selectClaims>>[number];

function toClaimView(tenant: Tenant, row: ClaimRow): ClaimView {
  return {
    id: row.id,
    status: row.status,
    merchant: row.merchant,
    amountKes: row.amountKes,
    spentOn: row.spentOn,
    description: row.description,
    category: { id: row.categoryId, name: row.categoryName },
    mpesaCode: row.mpesaCode,
    etimsInvoiceNumber: row.etimsInvoiceNumber,
    etimsSupplierPin: row.etimsSupplierPin,
    etimsQrPayload: row.etimsQrPayload,
    etimsStatus: row.etimsStatus,
    rejectedReason: row.rejectedReason,
    submittedBy: {
      membershipId: row.membershipId,
      name: row.submitterName,
      email: row.submitterEmail,
      payoutPhoneConfirmed: row.submitterPhoneConfirmed,
    },
    approvedAt: row.approvedAt,
    selfApproved: row.selfApproved,
    paidAt: row.paidAt,
    canEdit: row.membershipId === tenant.membershipId && isEditable(row.status),
    warnings: readsWholeCompany(tenant.role) ? readWarnings(row.warnings) : [],
    receiptCount: row.receiptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const encodeCursor = (row: ClaimRow): string =>
  Buffer.from(`${row.cursorAt}|${row.id}`, "utf8").toString("base64url");

function decodeCursor(
  cursor: string,
): Effect.Effect<{ readonly at: string; readonly id: string }, BadRequest> {
  const match = CURSOR_PATTERN.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  return match?.[1] && match[2]
    ? Effect.succeed({ at: match[1], id: match[2] })
    : Effect.fail(badCursor);
}

export interface ClaimListOptions {
  readonly status?: ExpenseStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/** Newest first, a page at a time. */
export function listClaims(
  tenant: Tenant,
  options: ClaimListOptions,
): Effect.Effect<ClaimsPageView, BadRequest | DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const after =
      options.cursor === undefined ? null : yield* decodeCursor(options.cursor);
    const rows = yield* withScope(tenant, (tx) =>
      query(() =>
        selectClaims(
          tx,
          and(
            visibleClaims(tenant),
            options.status === undefined
              ? undefined
              : eq(expenses.status, options.status),
            after === null
              ? undefined
              : sql`(${expenses.createdAt}, ${expenses.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
          ),
        )
          .orderBy(desc(expenses.createdAt), desc(expenses.id))
          .limit(options.limit + 1),
      ),
    );
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      claims: page.map((row) => toClaimView(tenant, row)),
      nextCursor:
        rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  });
}

/** A claim the caller can see, with short-lived links to its receipts. */
export function getClaim(
  tenant: Tenant,
  claimId: string,
): Effect.Effect<
  ClaimDetailView,
  NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    const { row, files, payout } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          selectClaims(
            tx,
            and(visibleClaims(tenant), eq(expenses.id, claimId)),
          ).limit(1),
        );
        if (!row) return yield* Effect.fail(claimNotFound);
        const payoutId = row.payoutId;
        const [payout] =
          readsWholeCompany(tenant.role) && payoutId
            ? yield* query(() =>
                tx
                  .select({
                    id: payouts.id,
                    status: payouts.status,
                    failureReason: payouts.failureReason,
                  })
                  .from(payouts)
                  .where(eq(payouts.id, payoutId)),
              )
            : [];
        const files = yield* query(() =>
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
        return { row, files, payout: payout ?? null };
      }),
    );
    const receipts = yield* Effect.forEach(
      files,
      (file): Effect.Effect<ClaimReceiptView, StorageError> => {
        if (file.kind === "sms_text" || file.storageKey === null) {
          return Effect.succeed({
            id: file.id,
            kind: "sms_text",
            text: file.smsText ?? "",
          });
        }
        const kind = file.kind;
        return storage.presignDownload(file.storageKey).pipe(
          Effect.map(({ url, expiresAt }) => ({
            id: file.id,
            kind,
            contentType: file.contentType,
            url,
            expiresAt,
          })),
        );
      },
    ).pipe(Effect.mapError(storageFailure));
    return { ...toClaimView(tenant, row), receipts, payout };
  });
}

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

const viewerOf = (tenant: Tenant) => ({
  membershipId: tenant.membershipId,
  isAdmin: tenant.role === "admin",
});

const sameWarnings = (
  a: readonly ExpenseWarning[],
  b: readonly ExpenseWarning[],
): boolean => JSON.stringify(a) === JSON.stringify(b);

/** spec §6.3: always `submitted`, by the caller, from the app. */
export function submitClaim(
  tenant: Tenant,
  fields: SubmitClaimFields,
): Effect.Effect<
  ClaimDetailView,
  BadRequest | Conflict | NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | FileStorage
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* checkSpentOn(fields.spentOn);
    yield* requireEvidence(fields.receiptFileIds.length);
    yield* checkAttachableReceipts(tenant, fields.receiptFileIds);
    const claimId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const category = yield* findCategory(
          tx,
          organizationId,
          fields.categoryId,
          { allowArchived: false },
        );
        const mpesaCode = yield* reconcileWithSms(
          { mpesaCode: fields.mpesaCode ?? null, amountKes: fields.amountKes },
          yield* smsTextAmong(tx, organizationId, {
            receiptFileIds: fields.receiptFileIds,
          }),
        );
        const values = {
          merchant: fields.merchant,
          amountKes: fields.amountKes,
          spentOn: fields.spentOn,
          categoryId: fields.categoryId,
          description: fields.description,
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
              kind: "claim",
              overviewHeading: "petty_cash",
              source: "app",
              status: "submitted",
              ...values,
              warnings,
              extraction,
            })
            .returning({ id: expenses.id }),
        );
        if (!created)
          return yield* Effect.dieMessage("claim insert wrote no row");
        yield* setExpenseReceipts(
          tx,
          tenant,
          created.id,
          fields.receiptFileIds,
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "expense.submitted",
          entity: { type: "expense", id: created.id },
          after: {
            kind: "claim",
            status: "submitted",
            ...values,
            warnings,
            receiptFileIds: fields.receiptFileIds,
          },
        });
        yield* notify(tx, {
          kind: "claim_submitted",
          organizationId,
          claimId: created.id,
        });
        return created.id;
      }),
    ).pipe(Effect.catchTag("DatabaseError", duplicateCodeConflict));
    return yield* getClaim(tenant, claimId);
  });
}

/**
 * The caller's own claim, locked, while they can still change it. Anyone
 * who can't see it gets 404; an admin who can see someone else's gets 403.
 */
function lockOwnEditableClaim(
  tx: Transaction,
  tenant: Tenant,
  claimId: string,
) {
  return Effect.gen(function* () {
    const [claim] = yield* query(() =>
      tx
        .select({
          membershipId: expenses.membershipId,
          status: expenses.status,
          merchant: expenses.merchant,
          amountKes: expenses.amountKes,
          spentOn: expenses.spentOn,
          categoryId: expenses.categoryId,
          description: expenses.description,
          mpesaCode: expenses.mpesaCode,
          etimsInvoiceNumber: expenses.etimsInvoiceNumber,
          etimsSupplierPin: expenses.etimsSupplierPin,
          etimsQrPayload: expenses.etimsQrPayload,
          etimsStatus: expenses.etimsStatus,
          rejectedReason: expenses.rejectedReason,
          warnings: expenses.warnings,
        })
        .from(expenses)
        .where(and(visibleClaims(tenant), eq(expenses.id, claimId)))
        .for("update"),
    );
    if (!claim) return yield* Effect.fail(claimNotFound);
    if (claim.membershipId !== tenant.membershipId) {
      return yield* Effect.fail(notYourClaim);
    }
    if (!isEditable(claim.status)) return yield* Effect.fail(notEditable);
    return claim;
  });
}

type EditableField =
  | "merchant"
  | "amountKes"
  | "spentOn"
  | "categoryId"
  | "description"
  | "mpesaCode"
  | "etimsInvoiceNumber"
  | "etimsSupplierPin"
  | "etimsQrPayload"
  | "etimsStatus";

/** Only what changed, for the audit entry. */
function changedFields(
  before: Readonly<Record<EditableField, unknown>>,
  after: Readonly<Record<EditableField, unknown>>,
): EditableField[] {
  return (Object.keys(after) as EditableField[]).filter(
    (field) => before[field] !== after[field],
  );
}

const pick = (
  values: Readonly<Record<EditableField, unknown>>,
  fields: readonly EditableField[],
) => Object.fromEntries(fields.map((field) => [field, values[field]]));

/** A field left out of an edit keeps its value; null clears it. */
function unlessLeftOut<T>(change: T | undefined, current: T): T {
  if (change === undefined) return current;
  return change;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

function countReceipts(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
): Effect.Effect<number, DatabaseError> {
  return query(() =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          eq(receiptFiles.expenseId, expenseId),
        ),
      ),
  ).pipe(Effect.map(([row]) => row?.count ?? 0));
}

/**
 * The owner's edit (spec §5). A field left out stays; null clears an
 * optional one. Editing a rejected claim resubmits it: it goes back to
 * `submitted` and its rejection reason moves to the audit log.
 */
export function updateClaim(
  tenant: Tenant,
  claimId: string,
  changes: UpdateClaimFields,
): Effect.Effect<
  ClaimDetailView,
  | BadRequest
  | Conflict
  | Forbidden
  | NotFound
  | ServiceUnavailable
  | DatabaseError,
  DatabaseService | AuditLog | FileStorage
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* checkSpentOn(changes.spentOn);
    // Refuses someone who can't edit it before any call to R2.
    yield* withScope(tenant, (tx) => lockOwnEditableClaim(tx, tenant, claimId));
    if (changes.receiptFileIds) {
      yield* checkAttachableReceipts(tenant, changes.receiptFileIds, claimId);
    }

    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const claim = yield* lockOwnEditableClaim(tx, tenant, claimId);
        const categoryId = changes.categoryId ?? claim.categoryId;
        const category = yield* findCategory(tx, organizationId, categoryId, {
          allowArchived: categoryId === claim.categoryId,
        });
        const receipts = changes.receiptFileIds
          ? {
              before: yield* setExpenseReceipts(
                tx,
                tenant,
                claimId,
                changes.receiptFileIds,
              ),
              after: changes.receiptFileIds,
            }
          : null;

        const amountKes = changes.amountKes ?? claim.amountKes;
        const mpesaCode = yield* reconcileWithSms(
          {
            mpesaCode:
              changes.mpesaCode === undefined
                ? claim.mpesaCode
                : changes.mpesaCode,
            amountKes,
          },
          yield* smsTextAmong(tx, organizationId, { expenseId: claimId }),
        );
        const next = {
          merchant: changes.merchant ?? claim.merchant,
          amountKes,
          spentOn: changes.spentOn ?? claim.spentOn,
          categoryId,
          description: changes.description ?? claim.description,
          mpesaCode,
          ...(yield* resolveEtims(
            {
              etimsQrPayload: unlessLeftOut(
                changes.etimsQrPayload,
                claim.etimsQrPayload,
              ),
              etimsInvoiceNumber: unlessLeftOut(
                changes.etimsInvoiceNumber,
                claim.etimsInvoiceNumber,
              ),
              etimsSupplierPin: unlessLeftOut(
                changes.etimsSupplierPin,
                claim.etimsSupplierPin,
              ),
            },
            category,
          )),
        };
        yield* requireEvidence(
          yield* countReceipts(tx, organizationId, claimId),
        );
        yield* checkDuplicateKeys(
          tx,
          organizationId,
          next,
          viewerOf(tenant),
          claimId,
        );
        const warnings = yield* expenseWarnings(tx, {
          id: claimId,
          organizationId,
          membershipId: claim.membershipId,
          amountKes: next.amountKes,
          spentOn: next.spentOn,
        });
        const previousWarnings = readWarnings(claim.warnings);
        const warningsChanged = !sameWarnings(previousWarnings, warnings);
        const receiptsChanged =
          receipts !== null && !sameSet(receipts.before, receipts.after);
        const changed = changedFields(claim, next);
        const resubmitting = claim.status === "rejected";
        if (!resubmitting && changed.length === 0 && !receiptsChanged) {
          // Nothing the person changed, but time or other claims moved on.
          if (warningsChanged) {
            yield* query(() =>
              tx
                .update(expenses)
                .set({ warnings })
                .where(eq(expenses.id, claimId)),
            );
          }
          return;
        }
        const newExtraction = receiptsChanged
          ? yield* extractionsOf(tx, organizationId, receipts.after)
          : null;

        yield* query(() =>
          tx
            .update(expenses)
            .set({
              ...next,
              ...(resubmitting && {
                status: "submitted" as const,
                rejectedReason: null,
              }),
              ...(receiptsChanged && { extraction: newExtraction }),
              warnings,
            })
            .where(eq(expenses.id, claimId)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: resubmitting ? "expense.resubmitted" : "expense.edited",
          entity: { type: "expense", id: claimId },
          before: {
            ...pick(claim, changed),
            ...(receiptsChanged && { receiptFileIds: receipts.before }),
            ...(warningsChanged && { warnings: previousWarnings }),
            ...(resubmitting && {
              status: claim.status,
              rejectedReason: claim.rejectedReason,
            }),
          },
          after: {
            ...pick(next, changed),
            ...(receiptsChanged && { receiptFileIds: receipts.after }),
            ...(warningsChanged && { warnings }),
            ...(resubmitting && { status: "submitted" }),
          },
        });
        if (resubmitting)
          yield* notify(tx, {
            kind: "claim_submitted",
            organizationId,
            claimId,
          });
      }),
    ).pipe(Effect.catchTag("DatabaseError", duplicateCodeConflict));
    return yield* getClaim(tenant, claimId);
  });
}

/**
 * An admin rejects a claim waiting for approval, with a reason the
 * employee sees (spec §5). They can edit and resubmit it.
 */
export function rejectClaim(
  tenant: Tenant,
  claimId: string,
  reason: string,
): Effect.Effect<
  ClaimDetailView,
  Conflict | NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | FileStorage
> {
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const [claim] = yield* query(() =>
          tx
            .select({ status: expenses.status })
            .from(expenses)
            .where(and(visibleClaims(tenant), eq(expenses.id, claimId)))
            .for("update"),
        );
        if (!claim) return yield* Effect.fail(claimNotFound);
        if (claim.status !== "submitted") {
          return yield* Effect.fail(
            new Conflict({
              message: "Only a claim waiting for approval can be rejected.",
            }),
          );
        }
        yield* query(() =>
          tx
            .update(expenses)
            .set({ status: "rejected", rejectedReason: reason })
            .where(eq(expenses.id, claimId)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "expense.rejected",
          entity: { type: "expense", id: claimId },
          before: { status: claim.status },
          after: { status: "rejected", rejectedReason: reason },
        });
        yield* notify(tx, {
          kind: "claim_rejected",
          organizationId: tenant.organizationId,
          claimId,
        });
      }),
    );
    return yield* getClaim(tenant, claimId);
  });
}
