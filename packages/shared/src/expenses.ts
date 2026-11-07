import { z } from "zod";

import type { ExpenseKind } from "./claims.js";
import {
  etimsStatusSchema,
  EXPENSE_SOURCES,
  expenseKindSchema,
  expenseStatusSchema,
  expenseWarningSchema,
  OVERVIEW_HEADINGS,
} from "./claims.js";
import { companySpendingReceiptSchema } from "./company-spending.js";

/**
 * All expenses, for the web dashboard (spec §6.14): every claim, petty cash
 * purchase and company spending record, for admins and accountants.
 * Expenses are money already spent; money owed to suppliers is a bill. So
 * salaries and bills aren't listed here, not even the company spending a
 * bill marked paid outside Expendi records: that bill shows in Bills.
 */

/**
 * How the list groups expenses. Petty cash is spending from a float plus
 * the claims a float purchase overspent into; issuing or topping up a float
 * pays the holder ahead of spending and is never an expense.
 */
export const EXPENSE_LIST_KINDS = ["claim", "petty_cash", "company"] as const;
export const expenseListKindSchema = z.enum(EXPENSE_LIST_KINDS, {
  error: "kind is claim, petty_cash or company.",
});
export type ExpenseListKind = z.infer<typeof expenseListKindSchema>;

export function expenseListKindOf(
  kind: ExpenseKind,
  floatId: string | null,
): ExpenseListKind {
  if (kind === "company") return "company";
  return kind === "float" || floatId !== null ? "petty_cash" : "claim";
}

/** A calendar month, e.g. 2026-10, in Nairobi time like every date here. */
export const expenseMonthSchema = z
  .string({ error: "month is YYYY-MM." })
  .regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, "month is YYYY-MM.");

export const EXPENSES_PAGE_MAX_SIZE = 100;

/**
 * What the list sorts by: purchase date, the person's name, the merchant,
 * the amount, or the status, most urgent first (payment failed, waiting
 * for approval, being paid, rejected, paid, paid before Expendi, recorded).
 * Ties go by purchase date, then when it was recorded, in the same
 * direction.
 */
export const EXPENSE_SORT_KEYS = [
  "date",
  "person",
  "merchant",
  "amount",
  "status",
] as const;
export type ExpenseSortKey = (typeof EXPENSE_SORT_KEYS)[number];

/** The filters `GET …/expenses` and `GET …/expenses/summary` share. */
const expenseFilterFields = {
  /** The claimant, the float holder, or the admin who recorded company spending. */
  membershipId: z.uuid({ error: "That person wasn't found." }).optional(),
  kind: expenseListKindSchema.optional(),
  categoryId: z.uuid({ error: "That category wasn't found." }).optional(),
  /** By the purchase date. */
  month: expenseMonthSchema.optional(),
  etimsStatus: etimsStatusSchema.optional(),
  status: expenseStatusSchema.optional(),
  /** `true`: only those with no receipt; `false`: only those with one. */
  noReceipt: z
    .enum(["true", "false"], { error: "noReceipt is true or false." })
    .transform((value) => value === "true")
    .optional(),
};

/**
 * `GET …/expenses`: a page at a time, latest purchase date first unless
 * `sort` and `dir` say otherwise. A cursor only continues the sort it came
 * from.
 */
export const expenseListQuerySchema = z.object({
  ...expenseFilterFields,
  sort: z
    .enum(EXPENSE_SORT_KEYS, {
      error: "sort is date, person, merchant, amount or status.",
    })
    .default("date"),
  dir: z
    .enum(["asc", "desc"], { error: "dir is asc or desc." })
    .default("desc"),
  /** `nextCursor` from the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(EXPENSES_PAGE_MAX_SIZE).default(50),
});

export type ExpenseListQuery = z.input<typeof expenseListQuerySchema>;

/** `GET …/expenses/summary`: the list's filters, without paging or sorting. */
export const expenseSummaryQuerySchema = z.object(expenseFilterFields);

export type ExpenseSummaryQuery = z.input<typeof expenseSummaryQuerySchema>;

const kesCents = z.string().regex(/^\d+$/);

export const expenseSchema = z.object({
  id: z.uuid(),
  kind: expenseKindSchema,
  listKind: expenseListKindSchema,
  status: expenseStatusSchema,
  /** `import` is history from the one-time spreadsheet import (spec §6.12). */
  source: z.enum(EXPENSE_SOURCES),
  overviewHeading: z.enum(OVERVIEW_HEADINGS),
  merchant: z.string(),
  /** KES cents, as a decimal string. */
  amountKes: kesCents,
  spentOn: z.iso.date(),
  /** Null only for imported history. */
  description: z.string().nullable(),
  category: z.object({ id: z.uuid(), name: z.string() }),
  /** The claimant, the float holder, or the admin who recorded company spending. */
  member: z.object({
    membershipId: z.uuid(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  mpesaCode: z.string().nullable(),
  etimsStatus: etimsStatusSchema,
  etimsInvoiceNumber: z.string().nullable(),
  etimsSupplierPin: z.string().nullable(),
  warnings: z.array(expenseWarningSchema),
  /** Its own receipts, plus its overspend claim's or its bill's. */
  receiptCount: z.number().int().nonnegative(),
  noReceipt: z.boolean(),
  /** Why it was saved without a receipt; never on a claim. */
  noReceiptReason: z.string().nullable(),
  rejectedReason: z.string().nullable(),
  selfApproved: z.boolean(),
  approvedAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
  /** The float it was spent from, or the float an overspend claim went over. */
  floatId: z.uuid().nullable(),
  /** On float spending: the claim for what didn't fit in the float. */
  overspendClaimId: z.uuid().nullable(),
  /** On company spending recorded by marking a bill paid outside Expendi. */
  bill: z
    .object({
      id: z.uuid(),
      payeeName: z.string(),
      reference: z.string().nullable(),
    })
    .nullable(),
  /** On company spending: the account it was paid from. */
  paidFromAccount: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
});

export type Expense = z.infer<typeof expenseSchema>;

export const expensesPageSchema = z.object({
  expenses: z.array(expenseSchema),
  nextCursor: z.string().nullable(),
});

export type ExpensesPage = z.infer<typeof expensesPageSchema>;

/**
 * A receipt image or PDF as a short-lived link, or a pasted M-Pesa SMS.
 * `billRole` marks a bill's invoice or proof of payment.
 */
export const expenseReceiptSchema = companySpendingReceiptSchema;
export type ExpenseReceipt = z.infer<typeof expenseReceiptSchema>;

export const expenseDetailSchema = expenseSchema.extend({
  receipts: z.array(expenseReceiptSchema),
});

export type ExpenseDetail = z.infer<typeof expenseDetailSchema>;

const expenseTotalsSchema = z.object({
  count: z.number().int().nonnegative(),
  /** KES cents, as a decimal string. */
  totalKes: kesCents,
});

/**
 * `GET …/expenses/summary`: every expense the filters match, not just a
 * page. `kinds` counts each tab with every filter but the kind.
 */
export const expensesSummarySchema = expenseTotalsSchema.extend({
  waitingForApproval: expenseTotalsSchema,
  withoutReceipt: expenseTotalsSchema,
  /** eTIMS status `none`. */
  withoutEtims: expenseTotalsSchema,
  kinds: z.object({
    claim: z.number().int().nonnegative(),
    petty_cash: z.number().int().nonnegative(),
    company: z.number().int().nonnegative(),
  }),
});

export type ExpensesSummary = z.infer<typeof expensesSummarySchema>;
