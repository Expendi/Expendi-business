import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type {
  AccountingConnectionRow,
  AccountingSyncRow,
  BillRow,
  Expense,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { ZohoExpenseDraft } from "./zoho-client.js";
import {
  bills,
  categories,
  expenses,
  memberships,
  paidFromAccounts,
  payees,
  payouts,
  payrollRuns,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { cashOutReceiptOf } from "../payout/receipts.js";

/**
 * What one queued item becomes in Zoho Books (spec §6.17, "What syncs" and
 * "Each Zoho expense"): one expense per paid claim, petty cash spending,
 * company spending, paid bill and payroll run, its Paid Through account
 * where the money came from:
 *
 * - claims and bills paid through Expendi: the Expendi wallet's account,
 *   a claim for spending over a float included, since the wallet paid it
 * - petty cash spending: the petty cash account
 * - company spending, and bills paid outside: the account the spending came
 *   from, as mapped
 *
 * A payroll run is one expense for its total, to the salaries account, with
 * no names or per-person amounts anywhere in it.
 */

/**
 * The item can't be posted as it stands. `retryable` when a person can fix
 * the cause on our side (e.g. the account mapping) and the next attempt may
 * succeed; otherwise the sync fails at once.
 */
export class CannotPost extends Data.TaggedError("CannotPost")<{
  readonly message: string;
  readonly retryable: boolean;
}> {}

export interface ZohoReceipt {
  readonly storageKey: string;
  readonly contentType: string;
  readonly fileName: string;
}

export interface ZohoPosting {
  readonly draft: ZohoExpenseDraft;
  /** Null when there's nothing Zoho accepts, e.g. an SMS-only claim. */
  readonly receipt: ZohoReceipt | null;
}

/** KES cents as Zoho's 2-decimal amount, by integer maths. */
export function kesDecimal(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

/** USDC base units (6 decimals) as USD, e.g. 60500000 → "60.50". */
function usdDecimal(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0{1,4}$/, "");
  return `${whole}.${fraction}`;
}

const ZOHO_TEXT_LIMIT = 100;
const SEPARATOR = " · ";

function shorten(text: string, limit: number): string {
  const characters = [...text];
  return characters.length <= limit
    ? text
    : `${characters
        .slice(0, Math.max(limit - 1, 0))
        .join("")
        .trimEnd()}…`;
}

const length = (text: string) => [...text].length;

const clean = (text: string | null) => text?.replace(/\s+/g, " ").trim() ?? "";

/**
 * Zoho takes 100 characters. The free text (`words`) gives way first, so
 * the `details` the accountant matches on survive whole.
 */
function fitDescription(
  wordsGiven: readonly (string | null)[],
  detailsGiven: readonly (string | null)[],
): string {
  const words = wordsGiven.map(clean).filter(Boolean);
  const details = detailsGiven.map(clean).filter(Boolean);
  const whole = [...words, ...details].join(SEPARATOR);
  if (length(whole) <= ZOHO_TEXT_LIMIT) return whole;
  const kept = details.join(SEPARATOR);
  const room = ZOHO_TEXT_LIMIT - length(kept) - length(SEPARATOR);
  return room < 2 || words.length === 0 || details.length === 0
    ? shorten(whole, ZOHO_TEXT_LIMIT)
    : `${shorten(words.join(SEPARATOR), room)}${SEPARATOR}${kept}`;
}

/** The merchant and the employee's words give way to the name and codes. */
export function claimDescription(claim: {
  readonly merchant: string;
  readonly description: string | null;
  readonly employeeName: string | null;
  readonly mpesaCode: string | null;
  readonly etimsInvoiceNumber: string | null;
  readonly etimsSupplierPin: string | null;
}): string {
  return fitDescription(
    [claim.merchant, claim.description],
    [claim.employeeName, ...receiptCodes(claim)],
  );
}

function receiptCodes(
  expense: Pick<
    Expense,
    "mpesaCode" | "etimsInvoiceNumber" | "etimsSupplierPin"
  >,
): string[] {
  return [
    expense.mpesaCode ? `M-Pesa ${expense.mpesaCode}` : "",
    expense.etimsInvoiceNumber ? `eTIMS ${expense.etimsInvoiceNumber}` : "",
    expense.etimsSupplierPin ? `PIN ${expense.etimsSupplierPin}` : "",
  ];
}

/** What Zoho's receipt upload accepts: images, and the PDFs bills can hold. */
const ZOHO_RECEIPT_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
};

/**
 * The first file Zoho would take, for an expense or a bill. A bill's
 * invoice comes before its proof of payment: it's what the accountant
 * books against.
 */
function receiptOf(
  tx: Transaction,
  organizationId: string,
  owner: { readonly expenseId: string } | { readonly billId: string },
  referenceNumber: string,
): Effect.Effect<ZohoReceipt | null, DatabaseError> {
  return query(() =>
    tx
      .select({
        storageKey: receiptFiles.storageKey,
        contentType: receiptFiles.contentType,
      })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          "expenseId" in owner
            ? eq(receiptFiles.expenseId, owner.expenseId)
            : eq(receiptFiles.billId, owner.billId),
          inArray(receiptFiles.kind, ["photo", "screenshot", "pdf"]),
          inArray(receiptFiles.contentType, Object.keys(ZOHO_RECEIPT_TYPES)),
          isNotNull(receiptFiles.storageKey),
        ),
      )
      .orderBy(
        asc(receiptFiles.billRole),
        asc(receiptFiles.createdAt),
        asc(receiptFiles.id),
      )
      .limit(1),
  ).pipe(
    Effect.map(([file]) =>
      file?.storageKey
        ? {
            storageKey: file.storageKey,
            contentType: file.contentType,
            fileName: `expendi-${referenceNumber}.${ZOHO_RECEIPT_TYPES[file.contentType] ?? "jpg"}`,
          }
        : null,
    ),
  );
}

const notPostable = (message: string) =>
  new CannotPost({ message, retryable: false });

const mappingNeeded = (message: string) =>
  new CannotPost({ message, retryable: true });

const UNFINISHED_MAPPING =
  "The Zoho account mapping isn't finished: choose the Paid Through and default accounts.";

/** The category's account, or the default; null until the mapping's saved. */
const expenseAccountOf = (
  categoryAccountId: string | null,
  connection: AccountingConnectionRow,
): string | null => categoryAccountId ?? connection.defaultAccountId;

/** Where company spending's money came from, as the accountant mapped it. */
function paidFromAccountOf(
  paidFrom: { readonly name: string | null; readonly accountId: string | null },
  hasSource: boolean,
): Effect.Effect<string, CannotPost> {
  if (!hasSource) {
    return Effect.fail(
      mappingNeeded(
        "This was marked paid without saying which account paid it. Choose the account on its company spending entry, then retry.",
      ),
    );
  }
  return paidFrom.accountId
    ? Effect.succeed(paidFrom.accountId)
    : Effect.fail(
        mappingNeeded(
          `Map the paid-from account "${paidFrom.name ?? "unknown"}" to a Zoho Paid Through account.`,
        ),
      );
}

function expensePosting(
  tx: Transaction,
  sync: AccountingSyncRow,
  connection: AccountingConnectionRow,
): Effect.Effect<ZohoPosting, CannotPost | DatabaseError> {
  return Effect.gen(function* () {
    const [found] = yield* query(() =>
      tx
        .select({
          expense: expenses,
          categoryAccountId: categories.accountingAccountId,
          personName: users.fullName,
          personEmail: users.email,
          paidFromName: paidFromAccounts.name,
          paidFromAccountId: paidFromAccounts.accountingAccountId,
        })
        .from(expenses)
        .innerJoin(categories, eq(categories.id, expenses.categoryId))
        .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .leftJoin(
          paidFromAccounts,
          eq(paidFromAccounts.id, expenses.paidFromAccountId),
        )
        .where(
          and(
            eq(expenses.id, sync.subjectId),
            eq(expenses.organizationId, sync.organizationId),
          ),
        ),
    );
    if (!found) return yield* notPostable("This expense no longer exists.");
    const { expense } = found;
    const accountId = expenseAccountOf(found.categoryAccountId, connection);
    const personName = found.personName ?? found.personEmail;

    let paidThroughAccountId: string | null;
    let description: string;
    switch (expense.kind) {
      case "claim":
        if (expense.status !== "paid" || expense.source !== "app") {
          return yield* notPostable(
            "Only claims paid through Expendi sync to Zoho.",
          );
        }
        paidThroughAccountId = connection.paidThroughAccountId;
        description = claimDescription({
          ...expense,
          employeeName: personName,
        });
        break;
      case "float":
        if (expense.status !== "recorded" || expense.source !== "app") {
          return yield* notPostable(
            "Only petty cash spending recorded in Expendi syncs to Zoho.",
          );
        }
        if (!connection.pettyCashAccountId) {
          return yield* mappingNeeded(
            "Choose the petty cash account in the Zoho mapping.",
          );
        }
        paidThroughAccountId = connection.pettyCashAccountId;
        description = claimDescription({
          ...expense,
          employeeName: personName,
        });
        break;
      case "company":
        if (expense.status !== "recorded" || expense.source !== "app") {
          return yield* notPostable(
            "Only company spending recorded in Expendi syncs to Zoho.",
          );
        }
        if (expense.billId !== null) {
          return yield* notPostable(
            "This spending is a bill paid outside Expendi, which syncs as the bill.",
          );
        }
        paidThroughAccountId = yield* paidFromAccountOf(
          { name: found.paidFromName, accountId: found.paidFromAccountId },
          expense.paidFromAccountId !== null,
        );
        description = fitDescription(
          [expense.merchant, expense.description],
          receiptCodes(expense),
        );
        break;
      case "card":
        if (expense.status !== "recorded" || expense.source !== "app") {
          return yield* notPostable(
            "Only Expendi card spending recorded in Expendi syncs to Zoho.",
          );
        }
        paidThroughAccountId = yield* paidFromAccountOf(
          { name: found.paidFromName, accountId: found.paidFromAccountId },
          expense.paidFromAccountId !== null,
        );
        description = fitDescription(
          [expense.merchant, expense.description],
          receiptCodes(expense),
        );
        break;
    }
    if (!accountId || !paidThroughAccountId) {
      return yield* mappingNeeded(UNFINISHED_MAPPING);
    }
    return {
      draft: {
        accountId,
        paidThroughAccountId,
        date: expense.spentOn,
        amount: kesDecimal(expense.amountKes),
        referenceNumber: expense.id,
        description,
      },
      // Spending over a float keeps the purchase's receipt on its claim.
      receipt: yield* receiptOf(
        tx,
        sync.organizationId,
        { expenseId: expense.overspendClaimId ?? expense.id },
        expense.id,
      ),
    };
  });
}

/** What a bill's payment out of Expendi was worth in KES, and its receipt number. */
function paidThroughExpendi(
  tx: Transaction,
  bill: BillRow,
): Effect.Effect<
  { readonly amountKes: bigint; readonly reference: string | null },
  CannotPost | DatabaseError
> {
  return Effect.gen(function* () {
    const { payoutId } = bill;
    const [payout] = payoutId
      ? yield* query(() =>
          tx
            .select({
              amountKes: payouts.amountKes,
              provider: payouts.provider,
              method: payouts.method,
              status: payouts.status,
              providerReference: payouts.providerReference,
            })
            .from(payouts)
            .where(
              and(
                eq(payouts.id, payoutId),
                eq(payouts.organizationId, bill.organizationId),
                eq(payouts.status, "paid"),
              ),
            ),
        )
      : [];
    // A USD bill pays exact USDC; its KES is what that was worth when paid.
    const amountKes =
      bill.currency === "usd" ? (payout?.amountKes ?? null) : bill.amountKes;
    if (amountKes === null) {
      return yield* notPostable("This bill's payment can't be found.");
    }
    // A cash-out's M-Pesa or bank receipt, whichever provider paid it; an
    // on-chain hash wouldn't fit.
    const reference = payout ? (cashOutReceiptOf(payout)?.code ?? null) : null;
    return { amountKes, reference };
  });
}

function billPosting(
  tx: Transaction,
  sync: AccountingSyncRow,
  connection: AccountingConnectionRow,
): Effect.Effect<ZohoPosting, CannotPost | DatabaseError> {
  return Effect.gen(function* () {
    const [found] = yield* query(() =>
      tx
        .select({
          bill: bills,
          categoryAccountId: categories.accountingAccountId,
          payeeName: payees.name,
        })
        .from(bills)
        .innerJoin(categories, eq(categories.id, bills.categoryId))
        .innerJoin(payees, eq(payees.id, bills.payeeId))
        .where(
          and(
            eq(bills.id, sync.subjectId),
            eq(bills.organizationId, sync.organizationId),
          ),
        ),
    );
    if (!found) return yield* notPostable("This bill no longer exists.");
    const { bill } = found;
    if (bill.payrollRunId !== null) {
      return yield* notPostable(
        "A salary payment syncs as part of its payroll run.",
      );
    }
    if (bill.paidOn === null) {
      return yield* notPostable("Only paid bills sync to Zoho.");
    }
    const usd =
      bill.currency === "usd" && bill.amountUsdc !== null
        ? `USD ${usdDecimal(bill.amountUsdc)}`
        : null;

    let amountKes: bigint;
    let paidThroughAccountId: string | null;
    let description: string;
    switch (bill.status) {
      case "paid": {
        const payment = yield* paidThroughExpendi(tx, bill);
        amountKes = payment.amountKes;
        paidThroughAccountId = connection.paidThroughAccountId;
        description = fitDescription(
          [found.payeeName, bill.notes],
          [
            bill.reference ? `Ref ${bill.reference}` : null,
            usd,
            payment.reference ? `Paid ${payment.reference}` : null,
          ],
        );
        break;
      }
      case "paid_outside": {
        // Marking it paid outside recorded the payment as company spending:
        // its amount in KES and the account it came from.
        const [spending] = yield* query(() =>
          tx
            .select({
              amountKes: expenses.amountKes,
              source: expenses.paidFromAccountId,
              paidFromName: paidFromAccounts.name,
              paidFromAccountId: paidFromAccounts.accountingAccountId,
            })
            .from(expenses)
            .leftJoin(
              paidFromAccounts,
              eq(paidFromAccounts.id, expenses.paidFromAccountId),
            )
            .where(
              and(
                eq(expenses.billId, bill.id),
                eq(expenses.organizationId, sync.organizationId),
              ),
            ),
        );
        if (!spending) {
          return yield* notPostable(
            "This bill's company spending entry can't be found.",
          );
        }
        amountKes = spending.amountKes;
        paidThroughAccountId = yield* paidFromAccountOf(
          {
            name: spending.paidFromName,
            accountId: spending.paidFromAccountId,
          },
          spending.source !== null,
        );
        description = fitDescription(
          [found.payeeName, bill.notes, bill.paidOutsideNote],
          [bill.reference ? `Ref ${bill.reference}` : null, usd],
        );
        break;
      }
      default:
        return yield* notPostable("Only paid bills sync to Zoho.");
    }
    const accountId = expenseAccountOf(found.categoryAccountId, connection);
    if (!accountId || !paidThroughAccountId) {
      return yield* mappingNeeded(UNFINISHED_MAPPING);
    }
    return {
      draft: {
        accountId,
        paidThroughAccountId,
        date: bill.paidOn,
        amount: kesDecimal(amountKes),
        referenceNumber: bill.id,
        description,
      },
      receipt: yield* receiptOf(
        tx,
        sync.organizationId,
        { billId: bill.id },
        bill.id,
      ),
    };
  });
}

/**
 * Salaries are private (spec §4): the run posts as its total alone, with no
 * names, no per-person amounts and no attachment. The per-person detail
 * stays in the export.
 */
function payrollRunPosting(
  tx: Transaction,
  sync: AccountingSyncRow,
  connection: AccountingConnectionRow,
): Effect.Effect<ZohoPosting, CannotPost | DatabaseError> {
  return Effect.gen(function* () {
    const [run] = yield* query(() =>
      tx
        .select({
          id: payrollRuns.id,
          status: payrollRuns.status,
          payDate: payrollRuns.payDate,
          totalKes: payrollRuns.totalKes,
        })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.id, sync.subjectId),
            eq(payrollRuns.organizationId, sync.organizationId),
          ),
        ),
    );
    if (!run) return yield* notPostable("This payroll run no longer exists.");
    if (run.status !== "paid") {
      return yield* notPostable("Only paid payroll runs sync to Zoho.");
    }
    const [paid] = yield* query(() =>
      tx
        .select({
          totalKes: sql<string>`coalesce(sum(${bills.amountKes}), 0)::text`,
        })
        .from(bills)
        .where(
          and(
            eq(bills.organizationId, sync.organizationId),
            eq(bills.payrollRunId, run.id),
            eq(bills.status, "paid"),
          ),
        ),
    );
    if (run.totalKes <= 0n || BigInt(paid?.totalKes ?? "0") !== run.totalKes) {
      return yield* notPostable(
        "This payroll run's payments don't add up to its total. Check the run before retrying.",
      );
    }
    if (!connection.salariesAccountId) {
      return yield* mappingNeeded(
        "Choose the salaries account in the Zoho mapping.",
      );
    }
    if (!connection.paidThroughAccountId) {
      return yield* mappingNeeded(UNFINISHED_MAPPING);
    }
    return {
      draft: {
        accountId: connection.salariesAccountId,
        paidThroughAccountId: connection.paidThroughAccountId,
        date: run.payDate,
        amount: kesDecimal(run.totalKes),
        referenceNumber: run.id,
        description: `Salaries${SEPARATOR}payroll run for ${run.payDate}`,
      },
      receipt: null,
    };
  });
}

/**
 * The Zoho expense for a queued item, read in its company's scope as the
 * company: bills, payroll runs and bill files are admins' and accountants'
 * only.
 */
export function postingFor(
  tx: Transaction,
  sync: AccountingSyncRow,
  connection: AccountingConnectionRow,
): Effect.Effect<ZohoPosting, CannotPost | DatabaseError> {
  switch (sync.subjectType) {
    case "expense":
      return expensePosting(tx, sync, connection);
    case "bill":
      return billPosting(tx, sync, connection);
    case "payroll_run":
      return payrollRunPosting(tx, sync, connection);
  }
}
