import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";

import type {
  CashOutReceipt,
  EtimsStatus,
  ExpenseStatus,
  ExpenseWarning,
  FloatMovementPhase,
  FloatMovementStatus,
  FloatMovementType,
  FloatStatus,
} from "@expendi-business/shared";
import { readsWholeCompany } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import {
  categories,
  expenses,
  floatMovements,
  floats,
  memberships,
  payouts,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { readWarnings } from "../expenses/rules.js";
import { paymentReceiptsBySubject } from "../payout/receipts.js";

/**
 * Reading floats (spec §6.22). A float's balance is never stored: every read
 * works it out from its movements and its spending, so it can't drift from
 * them. Only paid issues and top-ups count; one still waiting for approval
 * or on its way is shown on its own, not in what's left.
 *
 * Admins and accountants see every float; anyone else only the floats they
 * hold. Row-level security enforces the same (migrations 0048, 0051).
 */

/** `FloatSummary` before serialisation turns bigints and dates into strings. */
export interface FloatSummaryView {
  readonly id: string;
  readonly status: FloatStatus;
  readonly holder: {
    readonly membershipId: string;
    readonly name: string | null;
    readonly email: string;
  };
  readonly yours: boolean;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly issuedKes: bigint;
  readonly spentKes: bigint;
  readonly returnedKes: bigint;
  readonly writtenOffKes: bigint;
  readonly leftKes: bigint;
  readonly onTheWayKes: bigint;
  readonly awaitingApprovalKes: bigint;
  readonly spendingCount: number;
  readonly noReceiptCount: number;
}

export interface FloatMovementView {
  readonly id: string;
  readonly type: FloatMovementType;
  readonly status: FloatMovementStatus;
  readonly phase: FloatMovementPhase;
  readonly amountKes: bigint;
  readonly note: string | null;
  readonly recordedBy: string;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
  readonly paymentReceipts: readonly CashOutReceipt[];
  readonly payout: {
    readonly id: string;
    readonly status: Payout["status"];
    readonly failureReason: string | null;
  } | null;
}

export interface OverspendClaimView {
  readonly id: string;
  readonly amountKes: bigint;
  readonly status: ExpenseStatus;
}

export interface FloatSpendingView {
  readonly id: string;
  readonly merchant: string;
  readonly amountKes: bigint;
  readonly spentOn: string;
  readonly description: string | null;
  readonly category: { readonly id: string; readonly name: string };
  readonly etimsStatus: EtimsStatus;
  readonly noReceipt: boolean;
  readonly noReceiptReason: string | null;
  readonly receiptCount: number;
  readonly overspendClaim: OverspendClaimView | null;
  readonly warnings: readonly ExpenseWarning[];
  readonly createdAt: Date;
}

export interface FloatDetailView extends FloatSummaryView {
  readonly movements: readonly FloatMovementView[];
  readonly spending: readonly FloatSpendingView[];
  readonly overspendClaims: readonly (OverspendClaimView & {
    readonly merchant: string;
    readonly spentOn: string;
  })[];
}

export const floatNotFound = new NotFound({ message: "Float not found" });

/** What the balance is made of, KES cents. */
export interface FloatTotals {
  readonly issuedKes: bigint;
  readonly spentKes: bigint;
  readonly returnedKes: bigint;
  readonly writtenOffKes: bigint;
}

/** issued + top-ups − recorded spending − returns (spec §6.22), less anything written off at closing. */
export function floatLeft(totals: FloatTotals): bigint {
  return (
    totals.issuedKes -
    totals.spentKes -
    totals.returnedKes -
    totals.writtenOffKes
  );
}

/** Admins and accountants see every float; anyone else only theirs (spec §4). */
export function visibleFloats(tenant: Tenant): SQL | undefined {
  return and(
    eq(floats.organizationId, tenant.organizationId),
    readsWholeCompany(tenant.role)
      ? undefined
      : eq(floats.membershipId, tenant.membershipId),
  );
}

const PAID_THROUGH_EXPENDI = sql`${floatMovements.type} IN ('issue', 'top_up')`;

function movementTotal(where: SQL): SQL<string> {
  return sql<string>`(SELECT coalesce(sum(${floatMovements.amountKes}), 0)::text FROM ${floatMovements} WHERE ${floatMovements.floatId} = ${floats.id} AND ${where})`;
}

/** A pending issue or top-up, by its payout's status. */
function pendingTotal(awaitingApproval: boolean): SQL<string> {
  return sql<string>`(SELECT coalesce(sum(${floatMovements.amountKes}), 0)::text FROM ${floatMovements} JOIN ${payouts} ON ${payouts.id} = ${floatMovements.payoutId} WHERE ${floatMovements.floatId} = ${floats.id} AND ${floatMovements.status} = 'pending' AND ${awaitingApproval ? sql`${payouts.status} = 'awaiting_approval'` : sql`${payouts.status} <> 'awaiting_approval'`})`;
}

/** Spending with no receipt of its own and none on the claim its purchase overspent into. */
const SPENDING_WITHOUT_RECEIPT = sql`NOT EXISTS (SELECT 1 FROM ${receiptFiles} WHERE ${receiptFiles.expenseId} IN (${expenses.id}, ${expenses.overspendClaimId}))`;

const FLOAT_SPENDING = sql`${expenses.floatId} = ${floats.id} AND ${expenses.kind} = 'float'`;

const summaryColumns = {
  importedIssuedKes: floats.importedIssuedKes,
  importedSpentKes: floats.importedSpentKes,
  id: floats.id,
  status: floats.status,
  membershipId: floats.membershipId,
  holderName: users.fullName,
  holderEmail: users.email,
  openedAt: floats.openedAt,
  closedAt: floats.closedAt,
  issuedKes: movementTotal(
    sql`${PAID_THROUGH_EXPENDI} AND ${floatMovements.status} = 'paid'`,
  ),
  returnedKes: movementTotal(sql`${floatMovements.type} = 'return'`),
  writtenOffKes: movementTotal(sql`${floatMovements.type} = 'write_off'`),
  onTheWayKes: pendingTotal(false),
  awaitingApprovalKes: pendingTotal(true),
  spentKes: sql<string>`(SELECT coalesce(sum(${expenses.amountKes}), 0)::text FROM ${expenses} WHERE ${FLOAT_SPENDING})`,
  spendingCount: sql<number>`(SELECT count(*)::int FROM ${expenses} WHERE ${FLOAT_SPENDING})`,
  noReceiptCount: sql<number>`(SELECT count(*)::int FROM ${expenses} WHERE ${FLOAT_SPENDING} AND ${SPENDING_WITHOUT_RECEIPT})`,
};

const selectSummaries = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(summaryColumns)
    .from(floats)
    .innerJoin(memberships, eq(memberships.id, floats.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(where);

type SummaryRow = Awaited<ReturnType<typeof selectSummaries>>[number];

function toSummary(tenant: Tenant, row: SummaryRow): FloatSummaryView {
  const totals: FloatTotals = {
    issuedKes: BigInt(row.issuedKes) + row.importedIssuedKes,
    spentKes: BigInt(row.spentKes) + row.importedSpentKes,
    returnedKes: BigInt(row.returnedKes),
    writtenOffKes: BigInt(row.writtenOffKes),
  };
  return {
    id: row.id,
    status: row.status,
    holder: {
      membershipId: row.membershipId,
      name: row.holderName,
      email: row.holderEmail,
    },
    yours: row.membershipId === tenant.membershipId,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    ...totals,
    leftKes: floatLeft(totals),
    onTheWayKes: BigInt(row.onTheWayKes),
    awaitingApprovalKes: BigInt(row.awaitingApprovalKes),
    spendingCount: row.spendingCount,
    noReceiptCount: row.noReceiptCount,
  };
}

/** One float the caller can see, inside their transaction; null if they can't. */
export function readFloatSummary(
  tx: Transaction,
  tenant: Tenant,
  floatId: string,
): Effect.Effect<FloatSummaryView | null, DatabaseError> {
  return query(() =>
    selectSummaries(tx, and(visibleFloats(tenant), eq(floats.id, floatId))),
  ).pipe(Effect.map(([row]) => (row ? toSummary(tenant, row) : null)));
}

export interface FloatListOptions {
  readonly status?: FloatStatus | undefined;
  readonly mine?: boolean | undefined;
}

/** Open floats first, then the most recently opened. */
export function listFloats(
  tenant: Tenant,
  options: FloatListOptions,
): Effect.Effect<
  { readonly floats: readonly FloatSummaryView[] },
  DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectSummaries(
        tx,
        and(
          visibleFloats(tenant),
          options.status === undefined
            ? undefined
            : eq(floats.status, options.status),
          options.mine
            ? eq(floats.membershipId, tenant.membershipId)
            : undefined,
        ),
      ).orderBy(asc(floats.status), desc(floats.openedAt), desc(floats.id)),
    ),
  ).pipe(
    Effect.map((rows) => ({
      floats: rows.map((row) => toSummary(tenant, row)),
    })),
  );
}

export function movementPhase(
  status: FloatMovementStatus,
  payoutStatus: Payout["status"] | null,
): FloatMovementPhase {
  if (status !== "pending") return status;
  return payoutStatus === "awaiting_approval"
    ? "awaiting_approval"
    : "on_its_way";
}

const recorder = alias(users, "recorder");

const selectMovements = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select({
      id: floatMovements.id,
      type: floatMovements.type,
      status: floatMovements.status,
      amountKes: floatMovements.amountKes,
      note: floatMovements.note,
      recordedBy: sql<string>`coalesce(${recorder.fullName}, ${recorder.email})`,
      createdAt: floatMovements.createdAt,
      paidAt: floatMovements.paidAt,
      payoutId: payouts.id,
      payoutStatus: payouts.status,
      failureReason: payouts.failureReason,
    })
    .from(floatMovements)
    .innerJoin(recorder, eq(recorder.id, floatMovements.recordedBy))
    .leftJoin(payouts, eq(payouts.id, floatMovements.payoutId))
    .where(where);

type MovementRow = Awaited<ReturnType<typeof selectMovements>>[number];

function toMovement(
  tenant: Tenant,
  row: MovementRow,
  paymentReceipts: readonly CashOutReceipt[],
): FloatMovementView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    phase: movementPhase(row.status, row.payoutStatus),
    amountKes: row.amountKes,
    note: row.note,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    paymentReceipts,
    payout:
      readsWholeCompany(tenant.role) && row.payoutId && row.payoutStatus
        ? {
            id: row.payoutId,
            status: row.payoutStatus,
            failureReason: row.failureReason,
          }
        : null,
  };
}

/** One movement of a float the caller can see, inside their transaction. */
export function readMovement(
  tx: Transaction,
  tenant: Tenant,
  floatId: string,
  movementId: string,
): Effect.Effect<FloatMovementView | null, DatabaseError> {
  return Effect.gen(function* () {
    const [row] = yield* query(() =>
      selectMovements(
        tx,
        and(
          eq(floatMovements.organizationId, tenant.organizationId),
          eq(floatMovements.floatId, floatId),
          eq(floatMovements.id, movementId),
        ),
      ),
    );
    if (!row) return null;
    const receipts = yield* paymentReceiptsBySubject(
      tx,
      tenant.organizationId,
      "float",
      [row.id],
    );
    return toMovement(tenant, row, receipts.get(row.id) ?? []);
  });
}

const overspendClaim = alias(expenses, "overspend_claim");

const selectSpending = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select({
      id: expenses.id,
      merchant: expenses.merchant,
      amountKes: expenses.amountKes,
      spentOn: expenses.spentOn,
      description: expenses.description,
      categoryId: categories.id,
      categoryName: categories.name,
      etimsStatus: expenses.etimsStatus,
      noReceiptReason: expenses.noReceiptReason,
      warnings: expenses.warnings,
      receiptCount: sql<number>`(SELECT count(*)::int FROM ${receiptFiles} WHERE ${receiptFiles.expenseId} IN (${expenses.id}, ${expenses.overspendClaimId}))`,
      claimId: overspendClaim.id,
      claimAmountKes: overspendClaim.amountKes,
      claimStatus: overspendClaim.status,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .innerJoin(categories, eq(categories.id, expenses.categoryId))
    .leftJoin(overspendClaim, eq(overspendClaim.id, expenses.overspendClaimId))
    .where(where);

type SpendingRow = Awaited<ReturnType<typeof selectSpending>>[number];

function toSpending(tenant: Tenant, row: SpendingRow): FloatSpendingView {
  return {
    id: row.id,
    merchant: row.merchant,
    amountKes: row.amountKes,
    spentOn: row.spentOn,
    description: row.description,
    category: { id: row.categoryId, name: row.categoryName },
    etimsStatus: row.etimsStatus,
    noReceipt: row.receiptCount === 0,
    noReceiptReason: row.noReceiptReason,
    receiptCount: row.receiptCount,
    overspendClaim:
      row.claimId && row.claimAmountKes !== null && row.claimStatus
        ? {
            id: row.claimId,
            amountKes: row.claimAmountKes,
            status: row.claimStatus,
          }
        : null,
    warnings: readsWholeCompany(tenant.role) ? readWarnings(row.warnings) : [],
    createdAt: row.createdAt,
  };
}

/** One spending record of a float, inside the caller's transaction. */
export function readSpending(
  tx: Transaction,
  tenant: Tenant,
  spendingId: string,
): Effect.Effect<FloatSpendingView | null, DatabaseError> {
  return query(() =>
    selectSpending(
      tx,
      and(
        eq(expenses.organizationId, tenant.organizationId),
        eq(expenses.kind, "float"),
        eq(expenses.id, spendingId),
      ),
    ),
  ).pipe(Effect.map(([row]) => (row ? toSpending(tenant, row) : null)));
}

/** A float the caller can see, with its movements, spending and overspend claims. */
export function getFloat(
  tenant: Tenant,
  floatId: string,
): Effect.Effect<FloatDetailView, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) => readFloatDetail(tx, tenant, floatId));
}

export function readFloatDetail(
  tx: Transaction,
  tenant: Tenant,
  floatId: string,
): Effect.Effect<FloatDetailView, NotFound | DatabaseError> {
  return Effect.gen(function* () {
    const summary = yield* readFloatSummary(tx, tenant, floatId);
    if (!summary) return yield* Effect.fail(floatNotFound);
    const movements = yield* query(() =>
      selectMovements(
        tx,
        and(
          eq(floatMovements.organizationId, tenant.organizationId),
          eq(floatMovements.floatId, floatId),
        ),
      ).orderBy(desc(floatMovements.createdAt), desc(floatMovements.id)),
    );
    const spending = yield* query(() =>
      selectSpending(
        tx,
        and(
          eq(expenses.organizationId, tenant.organizationId),
          eq(expenses.floatId, floatId),
          eq(expenses.kind, "float"),
        ),
      ).orderBy(
        desc(expenses.spentOn),
        desc(expenses.createdAt),
        desc(expenses.id),
      ),
    );
    const claims = yield* query(() =>
      tx
        .select({
          id: expenses.id,
          amountKes: expenses.amountKes,
          status: expenses.status,
          merchant: expenses.merchant,
          spentOn: expenses.spentOn,
        })
        .from(expenses)
        .where(
          and(
            eq(expenses.organizationId, tenant.organizationId),
            eq(expenses.floatId, floatId),
            eq(expenses.kind, "claim"),
          ),
        )
        .orderBy(desc(expenses.spentOn), desc(expenses.createdAt)),
    );
    const receipts = yield* paymentReceiptsBySubject(
      tx,
      tenant.organizationId,
      "float",
      movements.map((row) => row.id),
    );
    return {
      ...summary,
      movements: movements.map((row) =>
        toMovement(tenant, row, receipts.get(row.id) ?? []),
      ),
      spending: spending.map((row) => toSpending(tenant, row)),
      overspendClaims: claims,
    };
  });
}
