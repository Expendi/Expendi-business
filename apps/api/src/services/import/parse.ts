import type { ImportField, ImportRequest } from "@expendi-business/shared";
import {
  IMPORT_FIELDS,
  parseImportSpreadsheet,
  payeeKindSchema,
  recurringScheduleSchema,
} from "@expendi-business/shared";

export function importDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : value;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(iso))
    throw new Error("Use a date as DD/MM/YYYY or YYYY-MM-DD.");
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    throw new Error("That calendar date doesn't exist.");
  return iso;
}

/** Decimal KES, never a floating point conversion. */
export function importAmount(value: string, allowZero = false): bigint {
  if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))
    throw new Error(
      "Use a KES amount such as 1,500.00, with at most two decimal places.",
    );
  const [whole = "", fraction = ""] = value.replaceAll(",", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > 9_223_372_036_854_775_807n || cents < (allowZero ? 0n : 1n))
    throw new Error("Amount is outside the supported range.");
  return cents;
}

export function mappedRows(input: ImportRequest): Record<string, string>[] {
  const { headers, rows, rowNumbers, ignored } = parseImportSpreadsheet(
    input.csv,
    input.layout,
  );
  if (
    input.layout === "shanga" &&
    !["history", "claim", "bill"].includes(input.kind)
  )
    throw new Error(
      "Use Paid history, Unpaid claims or bills for Shanga expense sheets. Salary and recurring schedules need a separate prepared file.",
    );
  const mapping = Object.entries(input.mapping);
  if (!mapping.length || mapping.some(([, h]) => !headers.includes(h)))
    throw new Error("Map the CSV columns before previewing.");
  if (new Set(mapping.map(([, h]) => h)).size !== mapping.length)
    throw new Error("Map each column to only one field.");
  const mapped: Record<string, string>[] = rows.map((row, i) => ({
    ...Object.fromEntries(
      mapping.map(([field, header]) => [
        field,
        row[headers.indexOf(header)] ?? "",
      ]),
    ),
    $row: String(rowNumbers[i]),
    ...(input.layout === "shanga"
      ? {
          $status: row[headers.indexOf("Status")] ?? "",
          status: row[headers.indexOf("Status")] ?? "",
        }
      : {}),
    // Retain unmapped source IDs, so otherwise-identical legitimate payments
    // remain distinct. Column order and filename do not affect identity.
    $source: JSON.stringify(
      headers
        .map((header, i) => [header, row[i]])
        .sort(([a = ""], [b = ""]) => a.localeCompare(b)),
    ),
  }));
  return [
    ...mapped,
    ...ignored.map((r) => ({ $row: String(r.row), $skip: r.message })),
  ].sort((a, b) => Number(a.$row) - Number(b.$row));
}

export function validateImportStatus(
  input: ImportRequest,
  row: Record<string, string>,
) {
  const value = input.layout === "shanga" ? row.$status : row.status;
  if (input.layout !== "shanga" && value === undefined) return;
  if (!["history", "claim", "bill"].includes(input.kind)) return;
  const expected = input.kind === "history" ? "paid" : "unpaid";
  if (value?.trim().toLowerCase() !== expected)
    throw new Error(
      `Status must be ${expected} for this record type. Confirm payment status and split paid and unpaid records into separate files.`,
    );
}

export function required(
  row: Record<string, string>,
  field: ImportField,
): string {
  const value = row[field]?.trim();
  if (!value) throw new Error(`Map and fill ${field}.`);
  if (value.length > 500)
    throw new Error(`${field} must be 500 characters or fewer.`);
  return value;
}

/** Empty CSV cells use the same defaults as unmapped columns. */
export function optionalValue(value: string | undefined) {
  return value === "" ? undefined : value;
}

export function payeeKind(value: string | undefined) {
  const parsed = payeeKindSchema.safeParse(optionalValue(value) ?? "supplier");
  if (!parsed.success)
    throw new Error(
      "Use employee, personnel, supplier, vendor or statutory for payeeKind.",
    );
  return parsed.data;
}

export function schedule(value: string | undefined) {
  const parsed = recurringScheduleSchema.safeParse(
    optionalValue(value) ?? "monthly",
  );
  if (!parsed.success)
    throw new Error("Use weekly, monthly, quarterly or yearly for schedule.");
  return parsed.data;
}

export function cleanValues(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    IMPORT_FIELDS.filter((key) => values[key]).map((key) => [
      key,
      values[key] ?? "",
    ]),
  );
}
