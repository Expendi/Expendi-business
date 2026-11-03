import { z } from "zod";

export const IMPORT_KINDS = [
  "payee",
  "salary",
  "recurring",
  "bill",
  "claim",
  "float",
  "history",
] as const;
export const IMPORT_FIELDS = [
  "name",
  "email",
  "payeeKind",
  "payee",
  "category",
  "heading",
  "amount",
  "date",
  "description",
  "mpesaCode",
  "schedule",
  "scheduleDay",
  "payVia",
  "issued",
  "left",
  "status",
  "reference",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_BYTES = 512_000;

export const importRequestSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(IMPORT_MAX_BYTES),
  layout: z.enum(["standard", "shanga"]).optional(),
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().min(1).max(200)),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;
export const companyImportRequestSchema = importRequestSchema.extend({
  kind: z.enum(["history", "bill"]),
  /** Explicit opt-in so older clients never create unreviewed master records. */
  createMissing: z.boolean().optional(),
  mapping: z.partialRecord(
    z.enum([
      "name",
      "payee",
      "category",
      "heading",
      "amount",
      "date",
      "description",
      "mpesaCode",
      "status",
      "reference",
    ]),
    z.string().min(1).max(200),
  ),
});
export type CompanyImportRequest = z.infer<typeof companyImportRequestSchema>;
export const companyImportCommitSchema = companyImportRequestSchema.extend({
  previewToken: z.string().min(1).max(300),
});
export const importCommitSchema = importRequestSchema.extend({
  previewToken: z.string().min(1).max(300),
});
export const importNewRecordSchema = z.object({
  kind: z.enum(["supplier", "category"]),
  name: z.string(),
});
export type ImportNewRecord = z.infer<typeof importNewRecordSchema>;
export const importRowReportSchema = z.object({
  row: z.number().int(),
  status: z.enum(["ready", "skipped", "error"]),
  message: z.string(),
  values: z.record(z.string(), z.string()),
  newRecords: z.array(importNewRecordSchema).optional(),
});
export const importReportSchema = z.object({
  rows: z.array(importRowReportSchema),
  ready: z.number().int(),
  skipped: z.number().int(),
  errors: z.number().int(),
  totalKes: z.string().regex(/^\d+$/).optional(),
  newRecords: z.array(importNewRecordSchema).optional(),
  previewToken: z.string().nullable(),
});
export type ImportReport = z.infer<typeof importReportSchema>;
export const importResultSchema = z.object({
  runId: z.uuid(),
  imported: z.number().int(),
  skipped: z.number().int(),
});
export const importHistoryEntrySchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  kind: z.enum(IMPORT_KINDS),
  importedBy: z.string(),
  createdAt: z.iso.datetime(),
  rowsImported: z.number().int(),
  rowsSkipped: z.number().int(),
});
export const importHistoryPageSchema = z.object({
  imports: z.array(importHistoryEntrySchema),
  nextOffset: z.number().int().nullable(),
});
export const importHistoryDetailSchema = importHistoryEntrySchema.extend({
  rows: z.array(importRowReportSchema),
});

/** Backwards-compatible CSV/TSV reader. */
export function parseImportCsv(source: string): {
  headers: string[];
  rows: string[][];
} {
  const { headers, rows } = parseImportSpreadsheet(source);
  return { headers, rows };
}

/** RFC 4180 quoting, including quoted newlines and Excel's UTF-8 BOM. */
export function parseImportSpreadsheet(
  source: string,
  layout: ImportRequest["layout"] = "standard",
) {
  if (new TextEncoder().encode(source).length > IMPORT_MAX_BYTES)
    throw new Error("Use a CSV or TSV smaller than 512 KB.");
  const text = source.replace(/^\uFEFF/, "");
  // Only an unquoted tab in the first record identifies TSV. Commas in
  // tab-separated amounts and quoted tabs in CSV must remain cell content.
  let inQuotes = false;
  let delimiter = ",";
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\r" || ch === "\n")) break;
    if (!inQuotes && ch === "\t") delimiter = "\t";
  }
  const records: string[][] = [];
  const numbers: number[] = [];
  let line = 1,
    startLine = 1;
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const finishCell = () => {
    row.push(cell.trim());
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    if (row.some(Boolean)) {
      records.push(row);
      numbers.push(startLine);
    }
    row = [];
    if (records.length > IMPORT_MAX_ROWS + 1)
      throw new Error(`Use at most ${IMPORT_MAX_ROWS} rows per file.`);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += ch;
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
      }
    } else if (ch === delimiter) finishCell();
    else if (ch === "\n" || ch === "\r") {
      finishRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      startLine = line;
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || ch === '"')
        throw new Error(
          "Malformed CSV quoting. Export the sheet as UTF-8 CSV again.",
        );
      cell += ch;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quote.");
  if (cell || row.length || closed) finishRow();
  const headers = records.shift();
  numbers.shift();
  const ignored: { row: number; message: string }[] = [];
  if (layout === "shanga") {
    if (headers?.includes("Income Category"))
      throw new Error(
        "Money In is income. This importer supports outgoing records only.",
      );
    if (
      !headers ||
      ![
        "Expense Category",
        "Item Description",
        "Date Purchased",
        "Cost",
        "Vendor",
      ].every((h) => headers.includes(h))
    )
      throw new Error(
        "Choose a Shanga expense sheet with Expense Category, Item Description, Date Purchased, Cost and Vendor columns.",
      );
    const width = Math.max(headers.length, ...records.map((r) => r.length));
    while (headers.length < width) headers.push("");
    const original = [...headers];
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] === "") headers[i] = `Unnamed column ${i + 1}`;
    }
    const headerLabels = new Set([
      ...original.filter(Boolean),
      "Days in",
      "per diem total",
      "Total",
      "price",
    ]);
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      const rowNumber = numbers[i];
      if (!record || rowNumber === undefined) continue;
      while (record.length < width) record.push("");
      const repeated =
        [
          "Expense Category",
          "Item Description",
          "Date Purchased",
          "Cost",
          "Vendor",
        ].every((h) => record[original.indexOf(h)] === h) &&
        record.every(
          (v) => !v || headerLabels.has(v) || /^Column \d+$/.test(v),
        );
      const placeholder =
        record.some(Boolean) &&
        record.every((v) => !v || /^Column \d+$/.test(v));
      const summary = record.every((v, j) => !v || !original[j]);
      if (repeated || placeholder || summary) {
        ignored.unshift({
          row: rowNumber,
          message: summary
            ? "Summary cells outside the named columns; not a transaction."
            : "Repeated template headings; not a transaction.",
        });
        records.splice(i, 1);
        numbers.splice(i, 1);
      }
    }
  }
  // Excel exports sometimes include an entirely empty trailing column.
  // Drop it only when every row is also empty there; never discard data.
  while (
    headers?.at(-1) === "" &&
    records.every((r) => r.length === headers.length && r.at(-1) === "")
  ) {
    headers.pop();
    for (const record of records) record.pop();
  }
  if (
    !headers?.length ||
    headers.some((h) => !h || h.length > 200) ||
    new Set(headers).size !== headers.length
  )
    throw new Error(
      "Use non-empty, unique column headings (at most 200 characters).",
    );
  if (headers.length > 50) throw new Error("Use at most 50 columns.");
  if (!records.length)
    throw new Error(
      "No transaction rows found. This file contains only headings, blank rows or summary cells. Request a populated export.",
    );
  if (records.some((r) => r.length !== headers.length))
    throw new Error(
      "Every row must have the same number of columns as the header.",
    );
  return { headers, rows: records, rowNumbers: numbers, ignored };
}

/** Suggestions only: names are not member emails, costs are not always totals. */
export function suggestImportMapping(
  headers: string[],
  kind: ImportRequest["kind"],
): ImportRequest["mapping"] {
  const result: ImportRequest["mapping"] = {};
  const aliases: Partial<Record<ImportField, string>> = {
    name: "Vendor",
    payee: "Vendor",
    email: "Member Email",
    category: "Expense Category",
    description: "Item Description",
    status: "Status",
    date:
      kind === "history" || kind === "claim" ? "Date Purchased" : "Due Date",
    ...(headers.includes("Total") || headers.some((h) => /^Column \d+$/.test(h))
      ? {}
      : { amount: "Cost" }),
  };
  for (const field of IMPORT_FIELDS) {
    const header = headers.includes(field) ? field : aliases[field];
    if (header && headers.includes(header)) result[field] = header;
  }
  return result;
}
