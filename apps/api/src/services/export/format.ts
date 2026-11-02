import { strToU8, zipSync } from "fflate";

/**
 * The export's file formats (spec §6.11), written by hand: a CSV, a zip and
 * the few parts of an Excel workbook it needs. Amounts are decimal strings
 * built from integer cents or base units, never from floats.
 */

/** A money cell: a number in the workbook, plain digits in a CSV. */
export interface AmountCell {
  readonly decimal: string;
}

export type Cell = string | AmountCell;
export type Row = readonly Cell[];

export interface Sheet {
  /** At most 31 characters, none of `[]:*?/\`. */
  readonly name: string;
  readonly rows: readonly Row[];
}

/** KES cents as a decimal, e.g. 150050n → "1500.50". */
export function kesDecimal(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const magnitude = cents < 0n ? -cents : cents;
  return `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

/** USDC base units as US dollars, e.g. 1500500000n → "1500.50". */
export function usdDecimal(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${whole}.${fraction}`;
}

export const kesCell = (cents: bigint): AmountCell => ({
  decimal: kesDecimal(cents),
});

export const usdCell = (units: bigint): AmountCell => ({
  decimal: usdDecimal(units),
});

const isAmount = (cell: Cell): cell is AmountCell => typeof cell !== "string";

/**
 * Spreadsheet apps run a CSV cell that starts like a formula, and merchant
 * names and invoice numbers are typed by people, so such text is kept as
 * text with a leading apostrophe.
 */
const FORMULA_START = /^[=+\-@\t\r]/u;

function csvCell(cell: Cell): string {
  const text = isAmount(cell)
    ? cell.decimal
    : FORMULA_START.test(cell)
      ? `'${cell}`
      : cell;
  return `"${text.replaceAll('"', '""')}"`;
}

/** UTF-8 with a byte-order mark, so Excel reads the accents and the shilling amounts right. */
export function csvFile(rows: readonly Row[]): Uint8Array {
  const lines = rows.map((row) => row.map(csvCell).join(","));
  return strToU8(`\uFEFF${lines.join("\r\n")}\r\n`);
}

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Photos and PDFs are compressed already. */
  readonly store?: boolean;
}

/** A fixed `mtime` keeps the same content byte-for-byte the same file. */
export function zipFile(entries: readonly ZipEntry[], mtime: Date): Uint8Array {
  return zipSync(
    Object.fromEntries(
      entries.map((entry) => [
        entry.name,
        [entry.bytes, { level: entry.store ? 0 : 6, mtime }] as const,
      ]),
    ),
  );
}

/** Drops the control characters XML 1.0 can't hold at all, even escaped. */
function xmlChars(value: string): string {
  return [...value]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) &&
        code !== 0xfffe &&
        code !== 0xffff
      );
    })
    .join("");
}

const xmlText = (value: string): string =>
  xmlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Style 1: built-in number format 4, `#,##0.00`. Style 2: bold, for headers. */
const STYLES = `<styleSheet xmlns="${MAIN_NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function worksheet(rows: readonly Row[]): string {
  const widths: number[] = [];
  const xmlRows = rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const text = isAmount(cell) ? cell.decimal : cell;
      widths[c] = Math.max(widths[c] ?? 8, Math.min(text.length + 2, 60));
      if (isAmount(cell))
        return `<c r="${ref}" s="1"><v>${cell.decimal}</v></c>`;
      const style = r === 0 ? ' s="2"' : "";
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
    });
    return `<row r="${r + 1}">${cells.join("")}</row>`;
  });
  const cols = widths
    .map(
      (width, c) =>
        `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");
  return `<worksheet xmlns="${MAIN_NS}">${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${xmlRows.join("")}</sheetData></worksheet>`;
}

/** An Excel workbook (Office Open XML) with one worksheet per sheet. */
export function workbookFile(
  sheets: readonly Sheet[],
  mtime: Date,
): Uint8Array {
  const part = (name: string, xml: string): ZipEntry => ({
    name,
    bytes: strToU8(`${XML_HEADER}${xml}`),
  });
  const sheetOverrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const sheetRels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="${DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  return zipFile(
    [
      part(
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`,
      ),
      part(
        "_rels/.rels",
        `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      part(
        "xl/workbook.xml",
        `<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_REL}"><sheets>${sheets
          .map(
            (sheet, i) =>
              `<sheet name="${xmlText(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join("")}</sheets></workbook>`,
      ),
      part(
        "xl/_rels/workbook.xml.rels",
        `<Relationships xmlns="${REL_NS}">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="${DOC_REL}/styles" Target="styles.xml"/></Relationships>`,
      ),
      part("xl/styles.xml", STYLES),
      ...sheets.map((sheet, i) =>
        part(`xl/worksheets/sheet${i + 1}.xml`, worksheet(sheet.rows)),
      ),
    ],
    mtime,
  );
}
