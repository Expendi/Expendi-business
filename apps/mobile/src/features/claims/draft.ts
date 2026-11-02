import type {
  ExtractedClaimField,
  ParsedMpesaSms,
  ReceiptExtractionResponse,
  ReceiptSmsResponse,
} from "@expendi-business/shared";
import { parseEtimsQr, parseMpesaSms } from "@expendi-business/shared";

import { formatKesCents } from "../../lib/money";

/** The form as typed; the API parses the amount and normalises the codes. */
export interface ClaimDraft {
  merchant: string;
  amount: string;
  spentOn: string;
  categoryId: string | null;
  description: string;
  mpesaCode: string;
  etimsInvoiceNumber: string;
  etimsSupplierPin: string;
  /** The eTIMS QR exactly as scanned; the API reads it again. */
  etimsQrPayload: string | null;
}

export type DraftField = keyof ClaimDraft;

/** Values read from an SMS, a receipt photo or an eTIMS QR, ready for the form. */
export type Prefill = Partial<
  Pick<
    ClaimDraft,
    | "merchant"
    | "amount"
    | "spentOn"
    | "mpesaCode"
    | "etimsInvoiceNumber"
    | "etimsSupplierPin"
  >
>;

/**
 * Where a value the person didn't type came from. `receipt_unsure` is a
 * value read from the photo that the reader wasn't confident about.
 */
export type FieldSource = "sms" | "qr" | "receipt" | "receipt_unsure";

export interface DraftState {
  draft: ClaimDraft;
  sources: Partial<Record<DraftField, FieldSource>>;
  /** Fields the person typed; reading a receipt never overwrites them. */
  typed: readonly DraftField[];
}

/**
 * `typed` lists the fields that already hold the person's values, e.g. on
 * an edit, so a receipt read later leaves them alone.
 */
export function initialDraftState(
  draft: ClaimDraft,
  typed: readonly DraftField[] = [],
): DraftState {
  return { draft, sources: {}, typed };
}

export function typeField<K extends DraftField>(
  state: DraftState,
  field: K,
  value: ClaimDraft[K],
): DraftState {
  const sources = { ...state.sources };
  delete sources[field];
  return {
    draft: { ...state.draft, [field]: value },
    sources,
    typed: state.typed.includes(field) ? state.typed : [...state.typed, field],
  };
}

/**
 * An SMS or QR the person chose to use replaces what it covers: the API
 * refuses a claim that contradicts it anyway.
 */
export function applyChosenPrefill(
  state: DraftState,
  prefill: Prefill,
  source: Extract<FieldSource, "sms" | "qr"> = "sms",
): DraftState {
  const fields = Object.keys(prefill) as (keyof Prefill)[];
  return {
    draft: { ...state.draft, ...prefill },
    sources: {
      ...state.sources,
      ...Object.fromEntries(fields.map((field) => [field, source])),
    },
    typed: state.typed.filter(
      (field) => !fields.includes(field as keyof Prefill),
    ),
  };
}

/** The form fields an SMS fills, with the date as the Nairobi calendar day it shows. */
export function smsPrefill(
  sms: Pick<
    ReceiptSmsResponse["sms"] | ParsedMpesaSms,
    "code" | "amountKesCents" | "counterparty" | "occurredAt"
  >,
): Prefill {
  return {
    merchant: sms.counterparty,
    amount: formatKesCents(sms.amountKesCents),
    spentOn: sms.occurredAt.slice(0, 10),
    mpesaCode: sms.code,
  };
}

export const UNREADABLE_SMS =
  "Couldn’t read this SMS, enter the details by hand.";

export type PastedSms =
  { ok: true; text: string; prefill: Prefill } | { ok: false; message: string };

/**
 * Reads a pasted SMS on the phone, so an unknown message falls back to
 * manual entry straight away. The API reads it again before accepting it.
 */
export function readPastedSms(text: string): PastedSms {
  const parsed = parseMpesaSms(text);
  return parsed.ok
    ? { ok: true, text, prefill: smsPrefill(parsed.sms) }
    : { ok: false, message: UNREADABLE_SMS };
}

type PrefillField = keyof Prefill;

const RECEIPT_FIELDS: Readonly<
  Record<ExtractedClaimField, PrefillField | null>
> = {
  merchant: "merchant",
  amountKes: "amount",
  spentOn: "spentOn",
  mpesaCode: "mpesaCode",
  etimsInvoiceNumber: "etimsInvoiceNumber",
  etimsSupplierPin: "etimsSupplierPin",
};

export interface ReceiptReading {
  prefill: Prefill;
  /** Filled fields the reader found hard to make out. */
  unsure: readonly PrefillField[];
}

export function receiptPrefill(
  read: Extract<ReceiptExtractionResponse, { status: "read" }>,
): ReceiptReading {
  const { fields } = read;
  const prefill: Prefill = {};
  if (fields.merchant) prefill.merchant = fields.merchant;
  if (fields.amountKes) prefill.amount = formatKesCents(fields.amountKes);
  if (fields.spentOn) prefill.spentOn = fields.spentOn;
  if (fields.mpesaCode) prefill.mpesaCode = fields.mpesaCode;
  if (fields.etimsInvoiceNumber) {
    prefill.etimsInvoiceNumber = fields.etimsInvoiceNumber;
  }
  if (fields.etimsSupplierPin) {
    prefill.etimsSupplierPin = fields.etimsSupplierPin;
  }
  const unsure = read.lowConfidence.flatMap((field) => {
    const draftField = RECEIPT_FIELDS[field];
    return draftField && draftField in prefill ? [draftField] : [];
  });
  return { prefill, unsure };
}

/**
 * A read receipt only fills fields nobody has set yet: not ones the person
 * typed, and not ones an SMS or an earlier receipt filled.
 */
export function applyReceiptPrefill(
  state: DraftState,
  { prefill, unsure }: ReceiptReading,
): DraftState {
  const fields = (Object.keys(prefill) as PrefillField[]).filter(
    (field) => !state.typed.includes(field) && !state.sources[field],
  );
  return {
    draft: {
      ...state.draft,
      ...Object.fromEntries(fields.map((field) => [field, prefill[field]])),
    },
    sources: {
      ...state.sources,
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          unsure.includes(field) ? "receipt_unsure" : "receipt",
        ]),
      ),
    },
    typed: state.typed,
  };
}

export interface ScannedQr {
  payload: string;
  prefill: Prefill;
  /** What to tell the person about the scan. */
  note: string;
}

/**
 * A scanned eTIMS QR on the phone: an eTIMS QR names the supplier but not
 * the invoice number, a TIMS QR the reverse. An unknown code is still
 * kept, for the admin to check by hand.
 */
export function readScannedQr(payload: string): ScannedQr {
  const parsed = parseEtimsQr(payload);
  if (!parsed.ok) {
    return {
      payload,
      prefill: {},
      note: "Couldn’t read this QR code. It’s kept with the claim; type the invoice number printed on the receipt.",
    };
  }
  const { qr } = parsed;
  const prefill: Prefill = {};
  if (qr.invoiceNumber) prefill.etimsInvoiceNumber = qr.invoiceNumber;
  if (qr.supplierPin) prefill.etimsSupplierPin = qr.supplierPin;
  return {
    payload,
    prefill,
    note: qr.invoiceNumber
      ? "eTIMS QR scanned."
      : "eTIMS QR scanned. Type the invoice number printed under the QR code.",
  };
}
