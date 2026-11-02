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
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_BYTES = 512_000;

export const importRequestSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(IMPORT_MAX_BYTES),
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().min(1).max(200)),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;
export const importCommitSchema = importRequestSchema.extend({
  previewToken: z.string().min(1).max(300),
});
export const importRowReportSchema = z.object({
  row: z.number().int(),
  status: z.enum(["ready", "skipped", "error"]),
  message: z.string(),
  values: z.record(z.string(), z.string()),
});
export const importReportSchema = z.object({
  rows: z.array(importRowReportSchema),
  ready: z.number().int(),
  skipped: z.number().int(),
  errors: z.number().int(),
  previewToken: z.string().nullable(),
});
export type ImportReport = z.infer<typeof importReportSchema>;
export const importResultSchema = z.object({
  runId: z.uuid(),
  imported: z.number().int(),
  skipped: z.number().int(),
});

/** RFC 4180 quoting, including quoted newlines and Excel's UTF-8 BOM. */
export function parseImportCsv(source: string): {
  headers: string[];
  rows: string[][];
} {
  if (new TextEncoder().encode(source).length > IMPORT_MAX_BYTES)
    throw new Error("Use a CSV smaller than 512 KB.");
  const text = source.replace(/^\uFEFF/, "");
  const records: string[][] = [];
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
    if (row.some(Boolean)) records.push(row);
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
      } else cell += ch;
    } else if (ch === ",") finishCell();
    else if (ch === "\n" || ch === "\r") {
      finishRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
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
  if (headers.length > 50 || !records.length)
    throw new Error("Use 1–50 columns and at least one data row.");
  if (records.some((r) => r.length !== headers.length))
    throw new Error(
      "Every row must have the same number of columns as the header.",
    );
  return { headers, rows: records };
}
