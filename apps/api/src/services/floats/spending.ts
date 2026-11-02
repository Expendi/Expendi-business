import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type {
  ExpenseWarning,
  RecordFloatSpendingFields,
} from "@expendi-business/shared";
import { formatKesAmount, splitFloatPurchase } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type {
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { FileStorage } from "../storage/file-storage.js";
import type {
  FloatSpendingView,
  FloatSummaryView,
  OverspendClaimView,
} from "./views.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import { categories, expenses, floats } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, Forbidden } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { requireReceiptOrReason } from "../expenses/company.js";
import { resolveEtims } from "../expenses/etims.js";
import { extractionsOf } from "../expenses/extraction.js";
import {
  checkAttachableReceipts,
  setExpenseReceipts,
} from "../expenses/receipts.js";
import {
  checkDuplicateKeys,
  expenseWarnings,
  nairobiToday,
} from "../expenses/rules.js";
import { reconcileWithSms, smsTextAmong } from "../expenses/sms-evidence.js";
import {
  floatNotFound,
  readFloatSummary,
  readSpending,
  visibleFloats,
} from "./views.js";

/**
 * "Paid from petty cash" (spec §6.22): the holder records a purchase with
 * the claim capture flow and its rules (spec §6.5). It's an expense of kind
 * `float`, `recorded`, under Petty cash: no approval, no payout.
 *
 * Under the float's row lock, the purchase is split against what's left:
 * whatever fits is float spending, and the extra becomes a `submitted`
 * claim for exactly that much, in the same transaction. The purchase's
 * evidence goes on that claim, because the admin approves it before paying
 * the holder back: its receipt files, M-Pesa code and eTIMS invoice number
 * (each allowed once per company) live there, and the float spending links
 * to the claim (`overspend_claim_id`) and counts its receipts as its own.
 * The non-unique eTIMS fields are on both.
 *
 * Without a receipt, the holder says why and the spending is flagged "no
 * receipt" for the admins. An overspend always needs one, as every claim
 * does.
 */

/** `FloatSpendingResult` before serialisation. */
export interface FloatSpendingResultView {
  readonly float: FloatSummaryView;
  readonly spending: FloatSpendingView | null;
  readonly overspendClaim: OverspendClaimView | null;
}

const notYourFloat = new Forbidden({
  message: "Only the person holding a float records what's spent from it.",
});
const floatClosed = new Conflict({
  message: "This float is closed. Submit a claim for this instead.",
});
const futureDate = new BadRequest({
  message: "The date can't be in the future.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});

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

function findCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
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
      ),
  ).pipe(
    Effect.flatMap(([category]) =>
      category && !category.archived
        ? Effect.succeed(category)
        : Effect.fail(unknownCategory),
    ),
  );
}

/** The holder's own open float, locked so two purchases can't both spend what's left. */
function lockOwnOpenFloat(tx: Transaction, tenant: Tenant, floatId: string) {
  return Effect.gen(function* () {
    const [float] = yield* query(() =>
      tx
        .select({
          id: floats.id,
          status: floats.status,
          membershipId: floats.membershipId,
        })
        .from(floats)
        .where(and(visibleFloats(tenant), eq(floats.id, floatId)))
        .for("update"),
    );
    if (!float) return yield* Effect.fail(floatNotFound);
    if (float.membershipId !== tenant.membershipId) {
      return yield* Effect.fail(notYourFloat);
    }
    if (float.status !== "open") return yield* Effect.fail(floatClosed);
    return float;
  });
}

const withoutSibling = (
  warnings: readonly ExpenseWarning[],
  siblingId: string | null,
): ExpenseWarning[] =>
  warnings.filter(
    (warning) =>
      siblingId === null ||
      warning.code !== "near_duplicate" ||
      warning.expenseId !== siblingId,
  );

/** Records a purchase paid from the caller's float, and a claim for anything over it. */
export function recordFloatSpending(
  tenant: Tenant,
  floatId: string,
  fields: RecordFloatSpendingFields,
): Effect.Effect<
  FloatSpendingResultView,
  | BadRequest
  | Conflict
  | Forbidden
  | NotFound
  | ServiceUnavailable
  | DatabaseError,
  DatabaseService | AuditLog | FileStorage
> {
  const { organizationId } = tenant;
  const receiptFileIds = fields.receiptFileIds;
  const noReceiptReason = fields.noReceiptReason ?? null;
  return Effect.gen(function* () {
    if (fields.spentOn > nairobiToday()) return yield* Effect.fail(futureDate);
    yield* requireReceiptOrReason(receiptFileIds.length, noReceiptReason);
    // Refuses someone who can't record against this float before any call to R2.
    yield* withScope(tenant, (tx) => lockOwnOpenFloat(tx, tenant, floatId));
    if (receiptFileIds.length > 0) {
      yield* checkAttachableReceipts(tenant, receiptFileIds);
    }

    const recorded = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* lockOwnOpenFloat(tx, tenant, floatId);
        const category = yield* findCategory(
          tx,
          organizationId,
          fields.categoryId,
        );
        const mpesaCode = yield* reconcileWithSms(
          { mpesaCode: fields.mpesaCode ?? null, amountKes: fields.amountKes },
          yield* smsTextAmong(tx, organizationId, { receiptFileIds }),
        );
        const purchase = {
          merchant: fields.merchant,
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
        const viewer = {
          membershipId: tenant.membershipId,
          isAdmin: tenant.role === "admin",
        };
        yield* checkDuplicateKeys(tx, organizationId, purchase, viewer, null);

        const before = yield* readFloatSummary(tx, tenant, floatId);
        if (!before) return yield* Effect.fail(floatNotFound);
        const { fromFloatKes, claimedKes } = splitFloatPurchase(
          fields.amountKes,
          before.leftKes,
        );
        if (claimedKes > 0n && receiptFileIds.length === 0) {
          return yield* Effect.fail(
            new BadRequest({
              message: `Only ${formatKesAmount(before.leftKes > 0n ? before.leftKes : 0n)} is left on your float, so ${formatKesAmount(claimedKes)} becomes a claim, and a claim needs a receipt. Add a photo or screenshot of the receipt, or paste the M-Pesa SMS.`,
            }),
          );
        }
        const extraction = yield* extractionsOf(
          tx,
          organizationId,
          receiptFileIds,
        );
        const rule = (amountKes: bigint) => ({
          id: null,
          organizationId,
          membershipId: tenant.membershipId,
          amountKes,
          spentOn: purchase.spentOn,
        });
        const common = {
          organizationId,
          membershipId: tenant.membershipId,
          overviewHeading: "petty_cash" as const,
          source: "app" as const,
          floatId,
          extraction,
        };

        let claimId: string | null = null;
        if (claimedKes > 0n) {
          const warnings = yield* expenseWarnings(tx, rule(claimedKes));
          const [claim] = yield* query(() =>
            tx
              .insert(expenses)
              .values({
                ...common,
                ...purchase,
                kind: "claim",
                status: "submitted",
                amountKes: claimedKes,
                warnings,
              })
              .returning({ id: expenses.id }),
          );
          if (!claim)
            return yield* Effect.dieMessage("claim insert wrote no row");
          claimId = claim.id;
          yield* setExpenseReceipts(tx, tenant, claim.id, receiptFileIds);
          yield* audit.record(tx, {
            actor: { type: "user", id: tenant.userId },
            organizationId,
            action: "expense.submitted",
            entity: { type: "expense", id: claim.id },
            after: {
              kind: "claim",
              status: "submitted",
              ...purchase,
              amountKes: claimedKes,
              warnings,
              receiptFileIds,
              floatOverspend: {
                floatId,
                purchaseKes: fields.amountKes,
                fromFloatKes,
                leftBeforeKes: before.leftKes,
              },
            },
          });
        }

        let spendingId: string | null = null;
        if (fromFloatKes > 0n) {
          const warnings = withoutSibling(
            yield* expenseWarnings(tx, rule(fromFloatKes)),
            claimId,
          );
          const own =
            claimId === null
              ? purchase
              : { ...purchase, mpesaCode: null, etimsInvoiceNumber: null };
          const [spending] = yield* query(() =>
            tx
              .insert(expenses)
              .values({
                ...common,
                ...own,
                kind: "float",
                status: "recorded",
                amountKes: fromFloatKes,
                overspendClaimId: claimId,
                noReceiptReason,
                warnings,
              })
              .returning({ id: expenses.id }),
          );
          if (!spending) {
            return yield* Effect.dieMessage(
              "float spending insert wrote no row",
            );
          }
          spendingId = spending.id;
          if (claimId === null) {
            yield* setExpenseReceipts(tx, tenant, spending.id, receiptFileIds);
          }
          yield* audit.record(tx, {
            actor: { type: "user", id: tenant.userId },
            organizationId,
            action: "expense.recorded",
            entity: { type: "expense", id: spending.id },
            after: {
              kind: "float",
              status: "recorded",
              ...own,
              amountKes: fromFloatKes,
              noReceiptReason,
              warnings,
              receiptFileIds: claimId === null ? receiptFileIds : [],
              overspendClaimId: claimId,
              leftBeforeKes: before.leftKes,
            },
          });
        }
        return { spendingId, claimId };
      }),
    ).pipe(Effect.catchTag("DatabaseError", duplicateCodeConflict));

    const { spendingId, claimId } = recorded;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const float = yield* readFloatSummary(tx, tenant, floatId);
        if (!float) return yield* Effect.fail(floatNotFound);
        return {
          float,
          spending:
            spendingId === null
              ? null
              : yield* readSpending(tx, tenant, spendingId),
          overspendClaim:
            claimId === null ? null : yield* readOverspendClaim(tx, claimId),
        };
      }),
    );
  });
}

function readOverspendClaim(
  tx: Transaction,
  claimId: string,
): Effect.Effect<OverspendClaimView | null, DatabaseError> {
  return query(() =>
    tx
      .select({
        id: expenses.id,
        amountKes: expenses.amountKes,
        status: expenses.status,
      })
      .from(expenses)
      .where(and(eq(expenses.id, claimId), eq(expenses.kind, "claim"))),
  ).pipe(Effect.map(([claim]) => claim ?? null));
}
