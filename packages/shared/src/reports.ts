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
