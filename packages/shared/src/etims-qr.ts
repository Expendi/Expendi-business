import { KRA_PIN_PATTERN } from "./organization.js";

/**
 * The QR code on a KRA tax receipt (spec §6.4, §6.6). Two layouts are in
 * use, both links to KRA's own invoice check:
 *
 * - **eTIMS** (OSCU/VSCU invoices):
 *   `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=<PIN><branch><signature>`,
 *   e.g. `Data=P051234567X00ABCDEF0123456789`: the supplier's 11-character
 *   KRA PIN, the 2-digit branch ID (`00` is head office) and the receipt
 *   signature, 16 characters. The invoice number isn't in this QR; it's
 *   printed on the receipt (e.g. "CU Invoice No. KRACU0100000001/123").
 *   KRA's sandbox uses `etims-sbx.kra.go.ke`. KRA's OSCU specification
 *   doesn't publish this URL; the layout comes from the receipt pages KRA
 *   serves and open-source eTIMS clients that build it (e.g. MutaiT/etims,
 *   navariltd/kenya-compliance).
 * - **TIMS** (older ETR devices):
 *   `https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=<CU invoice number>`,
 *   where the CU invoice number is 19 digits, sometimes padded with spaces.
 *
 * Some tills print the bare CU invoice number instead. Anything else is
 * `unrecognised`: the raw payload is still kept and the employee types the
 * number in. Only `kra.go.ke` links count, so a look-alike host can't fill
 * in a PIN. Pure string parsing: React Native's `URL` can't read hosts or
 * query strings.
 */

export const ETIMS_QR_MAX_BYTES = 2048;

export type EtimsQrFormat = "etims" | "tims" | "invoice_number";

export interface ParsedEtimsQr {
  format: EtimsQrFormat;
  /** Uppercase CU invoice number; null for an eTIMS QR, which doesn't carry it. */
  invoiceNumber: string | null;
  /** The supplier's KRA PIN, uppercase, when the QR carries it. */
  supplierPin: string | null;
  /** eTIMS only: the supplier's branch, e.g. `00`. */
  branchId: string | null;
  /** eTIMS only: the receipt signature KRA checks the invoice by. */
  receiptSignature: string | null;
}

export type EtimsQrParseResult =
  | { ok: true; qr: ParsedEtimsQr }
  | { ok: false; reason: "empty" | "too_long" | "unrecognised" };

const LINK = /^https?:\/\/([^/?#\s]+)([^?#\s]*)(?:\?([^#\s]*))?/i;
const ETIMS_DATA = /^([AP]\d{9}[A-Z])(\d{2})?([A-Z0-9]{0,64})$/;
/** Up to 64 characters, as the claim's invoice number field allows. */
const CU_INVOICE_NUMBER = /^[A-Z0-9][A-Z0-9/-]{0,63}$/;
const BARE_INVOICE_NUMBER = /^(?:\d{17,20}|KRACU[0-9A-Z]+\/\d+)$/;
const INVOICE_PARAMS = new Set([
  "invoiceno",
  "invoice_no",
  "cuin",
  "cuinvoiceno",
  "cu_invoice_no",
  "invno",
]);
const PIN_PARAMS = new Set(["traderpin", "pin", "supplierpin"]);

export function etimsQrByteLength(payload: string): number {
  return new TextEncoder().encode(payload).length;
}

export function parseEtimsQr(payload: string): EtimsQrParseResult {
  const text = payload.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (etimsQrByteLength(text) > ETIMS_QR_MAX_BYTES) {
    return { ok: false, reason: "too_long" };
  }
  const qr = LINK.test(text) ? parseLink(text) : parseBare(text);
  return qr ? { ok: true, qr } : { ok: false, reason: "unrecognised" };
}

function parseLink(text: string): ParsedEtimsQr | null {
  const [, authority = "", path = "", queryString = ""] = LINK.exec(text) ?? [];
  const host = authority.replace(/^.*@/, "").replace(/:\d+$/, "").toLowerCase();
  if (host !== "kra.go.ke" && !host.endsWith(".kra.go.ke")) return null;
  const params = queryParams(queryString);

  if (/indexetimsreceiptdata/i.test(path)) {
    const data = ETIMS_DATA.exec(params.get("data")?.toUpperCase() ?? "");
    if (!data?.[1]) return null;
    return {
      format: "etims",
      invoiceNumber: null,
      supplierPin: data[1],
      branchId: data[2] ?? null,
      receiptSignature:
        data[3] === undefined || data[3] === "" ? null : data[3],
    };
  }

  const invoiceNumber = firstParam(params, INVOICE_PARAMS)?.toUpperCase();
  if (invoiceNumber === undefined || !CU_INVOICE_NUMBER.test(invoiceNumber)) {
    return null;
  }
  const pin = firstParam(params, PIN_PARAMS)?.toUpperCase();
  return {
    format: "tims",
    invoiceNumber,
    supplierPin: pin !== undefined && KRA_PIN_PATTERN.test(pin) ? pin : null,
    branchId: null,
    receiptSignature: null,
  };
}

function parseBare(text: string): ParsedEtimsQr | null {
  const invoiceNumber = text.toUpperCase();
  if (!BARE_INVOICE_NUMBER.test(invoiceNumber)) return null;
  return {
    format: "invoice_number",
    invoiceNumber,
    supplierPin: null,
    branchId: null,
    receiptSignature: null,
  };
}

/** Keys lowercased, values decoded and trimmed; the first of a repeated key wins. */
function queryParams(queryString: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of queryString.split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = decode(pair.slice(0, separator)).toLowerCase();
    if (!params.has(key))
      params.set(key, decode(pair.slice(separator + 1)).trim());
  }
  return params;
}

function firstParam(
  params: ReadonlyMap<string, string>,
  names: ReadonlySet<string>,
): string | undefined {
  for (const [key, value] of params) {
    if (names.has(key) && value !== "") return value;
  }
  return undefined;
}

/** A malformed escape stays as it was rather than failing the whole scan. */
function decode(component: string): string {
  const spaced = component.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}
