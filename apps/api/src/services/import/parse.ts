import type { ImportField, ImportRequest } from "@expendi-business/shared";
import {
  IMPORT_FIELDS,
  parseImportCsv,
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
  const { headers, rows } = parseImportCsv(input.csv);
  const mapping = Object.entries(input.mapping);
  if (!mapping.length || mapping.some(([, h]) => !headers.includes(h)))
    throw new Error("Map the CSV columns before previewing.");
  if (new Set(mapping.map(([, h]) => h)).size !== mapping.length)
    throw new Error("Map each column to only one field.");
  return rows.map((row) => ({
    ...Object.fromEntries(
      mapping.map(([field, header]) => [
        field,
        row[headers.indexOf(header)] ?? "",
      ]),
    ),
    // Retain unmapped source IDs, so otherwise-identical legitimate payments
    // remain distinct. Column order and filename do not affect identity.
    $source: JSON.stringify(
      headers
        .map((header, i) => [header, row[i]])
        .sort(([a = ""], [b = ""]) => a.localeCompare(b)),
    ),
  }));
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
