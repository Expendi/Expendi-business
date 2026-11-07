import { z } from "zod";

/** A Nairobi calendar month, `YYYY-MM`. */
export const reportMonthSchema = z
  .string()
  .regex(/^(20\d{2})-(0[1-9]|1[0-2])$/, "Choose a month in YYYY-MM format");

/**
 * What a month can be downloaded as straight away, without generating a
 * shareable export: the export's own files, and the eTIMS report.
 */
export const REPORT_FORMATS = ["workbook", "csv", "receipts", "etims"] as const;
export const reportFormatSchema = z.enum(REPORT_FORMATS);
export type ReportFormat = z.infer<typeof reportFormatSchema>;

/** The name a month's file is saved under, e.g. `expendi-2026-10.xlsx`. */
export function reportFilename(month: string, format: ReportFormat): string {
  switch (format) {
    case "workbook":
      return `expendi-${month}.xlsx`;
    case "csv":
      return `expendi-${month}-csv.zip`;
    case "receipts":
      return `expendi-${month}-receipts.zip`;
    case "etims":
      return `expendi-${month}-etims.csv`;
  }
}

/**
 * The files of a generated export (spec §6.11): the Excel workbook, the
 * same sheets as UTF-8 CSV files in a zip, and the month's receipts.
 */
export const EXPORT_FILES = ["workbook", "csv", "receipts"] as const;
export const exportFileSchema = z.enum(EXPORT_FILES);
export type ExportFile = z.infer<typeof exportFileSchema>;

export const createExportRequestSchema = z.object({
  month: reportMonthSchema,
});
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

export const exportSummarySchema = z.object({
  id: z.string(),
  month: reportMonthSchema,
  /** Made by the monthly job and emailed to the accountants. */
  monthly: z.boolean(),
  /** The admin who generated it; null for the monthly job's. */
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** When its emailed or shared links stop working. */
  expiresAt: z.iso.datetime(),
});
export type ExportSummary = z.infer<typeof exportSummarySchema>;

export const exportListSchema = z.array(exportSummarySchema);

/**
 * A freshly generated export. Its links work for anyone who has them until
 * `expiresAt`, and are only ever shown here.
 */
export const generatedExportSchema = exportSummarySchema.extend({
  links: z.object({
    workbook: z.url(),
    csv: z.url(),
    receipts: z.url(),
  }),
});
export type GeneratedExport = z.infer<typeof generatedExportSchema>;

/** A short-lived link to one of an export's files. */
export const exportFileUrlSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type ExportFileUrl = z.infer<typeof exportFileUrlSchema>;

const kesCents = z.string().regex(/^-?\d+$/);
const count = z.int().nonnegative();

/**
 * `GET /organizations/:id/reports/spending`: money out by month for the
 * reports charts. `month` is the last month shown (this Nairobi month when
 * left out) and `months` how many to show.
 */
export const reportSpendingQuerySchema = z.object({
  month: reportMonthSchema.optional(),
  months: z
    .enum(["6", "12"], { error: "Show 6 or 12 months." })
    .default("6")
    .transform(Number),
});
export type ReportSpendingQuery = z.input<typeof reportSpendingQuerySchema>;

/** KES cents paid out under each overview heading. */
export const spendingByHeadingSchema = z.object({
  petty_cash: kesCents,
  transactions: kesCents,
  salaries: kesCents,
  subscriptions: kesCents,
});
export type SpendingByHeading = z.infer<typeof spendingByHeadingSchema>;

/**
 * One month's money out, counted exactly as the spending overview counts it
 * (cash basis: by the Nairobi day it was paid or recorded).
 */
export const spendingMonthSchema = z.object({
  month: reportMonthSchema,
  totalKes: kesCents,
  /** Payments counted: a payout, or a spending row recorded outside Expendi. */
  payments: count,
  headings: spendingByHeadingSchema,
});
export type SpendingMonth = z.infer<typeof spendingMonthSchema>;

export const spendingCategoryMonthsSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Lined up with the response's `months`. */
  months: z.array(spendingMonthSchema),
});
export type SpendingCategoryMonths = z.infer<
  typeof spendingCategoryMonthsSchema
>;

export const SPENDING_PAYMENT_KINDS = [
  "claim",
  "bill",
  "company",
  "float",
] as const;

export const largestPaymentSchema = z.object({
  /** The payout or spending row. */
  id: z.string(),
  /** The claim, bill or spending it pays for. */
  subjectId: z.string(),
  kind: z.enum(SPENDING_PAYMENT_KINDS),
  /** The merchant, or the payee for a bill. */
  name: z.string(),
  date: z.iso.date(),
  amountKes: kesCents,
  categoryId: z.string(),
  /** Who was paid or spent it; null for company spending. */
  personName: z.string().nullable(),
});
export type LargestPayment = z.infer<typeof largestPaymentSchema>;

export const reportSpendingSchema = z.object({
  /** The last month shown. */
  month: reportMonthSchema,
  /** Today in Nairobi: a month that includes it is so far. */
  today: z.iso.date(),
  /**
   * Oldest first: the months asked for, and the month before them first so
   * every month shown has one to compare with.
   */
  months: z.array(spendingMonthSchema),
  /** Every category with money out in those months, by name. */
  categories: z.array(spendingCategoryMonthsSchema),
  /** `month`'s five largest payments in each category, largest first. */
  largestPayments: z.array(largestPaymentSchema),
});
export type ReportSpending = z.infer<typeof reportSpendingSchema>;

export const MONEY_OUT_KINDS = [
  "claim",
  "float",
  "bill",
  "salary",
  "company",
] as const;
export type MoneyOutKind = (typeof MONEY_OUT_KINDS)[number];

export const REPORT_PREVIEW_ROWS = 5;
export const REPORT_PREVIEW_RECEIPTS = 8;
export const REPORT_PREVIEW_ETIMS_ROWS = 6;

/**
 * `GET /organizations/:id/reports/:month/summary`: what a month's files
 * hold, read the same way the files are made, with each file's first rows.
 */
export const reportMonthSummarySchema = z.object({
  month: reportMonthSchema,
  moneyOut: z.object({
    rows: count,
    /** Rows that came from the spreadsheet import, with no receipts or eTIMS details. */
    importedRows: count,
    totalKes: kesCents,
    preview: z.array(
      z.object({
        date: z.iso.date(),
        kind: z.enum(MONEY_OUT_KINDS),
        /** The payee or employee, or the merchant for company spending. */
        name: z.string(),
        amountKes: kesCents,
      }),
    ),
  }),
  outstanding: z.object({
    rows: count,
    /** Of the KES bills. */
    totalKes: kesCents,
    /** Of the USD bills, USDC base units. */
    totalUsdc: z.string().regex(/^\d+$/),
    /** Due before the month's last day. */
    overdue: count,
    withoutAmount: count,
    preview: z.array(
      z.object({
        dueOn: z.iso.date(),
        payee: z.string(),
        overdue: z.boolean(),
        amountKes: kesCents.nullable(),
        amountUsdc: z.string().regex(/^\d+$/).nullable(),
      }),
    ),
  }),
  floatTransfers: z.object({
    rows: count,
    preview: z.array(
      z.object({
        date: z.iso.date(),
        type: z.enum(["issue", "top_up"]),
        person: z.string(),
        amountKes: kesCents,
      }),
    ),
  }),
  receipts: z.object({
    files: count,
    /** The first files' names in the zip. */
    names: z.array(z.string()),
    /** Reimbursements, petty cash and company spending with no receipt. */
    expensesWithout: count,
    withoutPreview: z.array(
      z.object({
        date: z.iso.date(),
        merchant: z.string(),
        amountKes: kesCents,
      }),
    ),
  }),
  etims: z.object({
    rows: count,
    attached: count,
    none: count,
    notRequired: count,
    preview: z.array(
      z.object({
        date: z.iso.date(),
        merchant: z.string(),
        amountKes: kesCents,
        /** Empty for an imported row. */
        status: z.enum(["attached", "none", "not_required", ""]),
      }),
    ),
  }),
});
export type ReportMonthSummary = z.infer<typeof reportMonthSummarySchema>;
