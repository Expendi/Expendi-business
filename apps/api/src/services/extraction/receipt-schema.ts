import { z } from "zod";

import { KRA_PIN_PATTERN } from "@expendi-business/shared";

/**
 * The fields read from a receipt photo or payment screenshot (spec §6.3,
 * §6.4). They only pre-fill the claim form: the employee always reviews
 * them before submitting.
 */

export const RECEIPT_KINDS = [
  "paper_receipt",
  "mpesa_screenshot",
  "invoice",
  "other",
] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const RECEIPT_FIELD_NAMES = [
  "merchant",
  "amount",
  "currency",
  "date",
  "mpesaCode",
  "etimsInvoiceNumber",
  "supplierKraPin",
] as const;
export type ReceiptFieldName = (typeof RECEIPT_FIELD_NAMES)[number];

/**
 * What Claude is asked to return, sent as the structured-output schema:
 * values copied from the image as printed, null where absent or unclear.
 * Formats are checked afterwards, by `checkReceiptReply`.
 */
export const receiptReplySchema = z.object({
  readable: z.boolean(),
  unreadableReason: z.enum(["not_a_receipt", "illegible"]).nullable(),
  kind: z.enum(RECEIPT_KINDS),
  merchant: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  date: z.string().nullable(),
  mpesaCode: z.string().nullable(),
  etimsInvoiceNumber: z.string().nullable(),
  supplierKraPin: z.string().nullable(),
  uncertainFields: z.array(z.enum(RECEIPT_FIELD_NAMES)),
});
export type ReceiptReply = z.infer<typeof receiptReplySchema>;

/** KES 100 million: anything larger is a misread, e.g. a phone number. */
const MAX_AMOUNT_CENTS = 10_000_000_000n;
const CENTS_PATTERN = /^[1-9]\d*$/;
/** M-Pesa transaction codes: 10 characters, starting with a letter. */
export const MPESA_CODE_PATTERN = /^[A-Z][A-Z0-9]{9}$/;
const ETIMS_INVOICE_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9/-]{0,49}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** "1,234.50", "1234.5" or "850": digits, optional thousands commas, up to 2 decimals. */
const PRINTED_AMOUNT_PATTERN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;

const confidenceSchema = z.enum(["high", "low"]);

export const receiptFieldsSchema = z.object({
  kind: z.enum(RECEIPT_KINDS),
  merchant: z.string().min(1).max(200).nullable(),
  /** Integer hundredths of `currency`, as a string; KES cents for a KES receipt. */
  amountCents: z
    .string()
    .regex(CENTS_PATTERN)
    .refine((cents) => BigInt(cents) <= MAX_AMOUNT_CENTS)
    .nullable(),
  /** ISO 4217. Only a KES amount can pre-fill a claim; see `ReceiptFlag`. */
  currency: z.string().regex(CURRENCY_PATTERN).nullable(),
  date: z.iso.date().nullable(),
  mpesaCode: z.string().regex(MPESA_CODE_PATTERN).nullable(),
  etimsInvoiceNumber: z.string().regex(ETIMS_INVOICE_NUMBER_PATTERN).nullable(),
  supplierKraPin: z.string().regex(KRA_PIN_PATTERN).nullable(),
  /** One entry per field that was read; absent fields have none. */
  confidence: z.partialRecord(z.enum(RECEIPT_FIELD_NAMES), confidenceSchema),
});
export type ReceiptFields = z.infer<typeof receiptFieldsSchema>;

/** `currency_not_kes`: the amount is in another (or no) currency, so it can't pre-fill KES. */
export type ReceiptFlag = "currency_not_kes";

/**
 * A printed amount in integer hundredths, e.g. "1,234.50" → "123450",
 * using only integer maths. Null for anything that isn't a plain positive
 * amount up to KES 100 million.
 */
export function decimalToCents(printed: string): string | null {
  const trimmed = printed.trim();
  if (!PRINTED_AMOUNT_PATTERN.test(trimmed)) return null;
  const [whole = "", fraction = ""] = trimmed.replaceAll(",", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents > 0n && cents <= MAX_AMOUNT_CENTS ? cents.toString() : null;
}

const EARLIEST_RECEIPT_DATE = "2000-01-01";
const NAIROBI_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A receipt can't be dated after tomorrow in Nairobi (a day of slack for
 * clocks), nor before 2000: such a date is a misread year.
 */
export function isPlausibleReceiptDate(date: string, now: Date): boolean {
  const latest = new Date(now.getTime() + NAIROBI_UTC_OFFSET_MS + DAY_MS)
    .toISOString()
    .slice(0, 10);
  return date >= EARLIEST_RECEIPT_DATE && date <= latest;
}

const blankToNull = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

const compactUpper = (value: string | null): string | null =>
  blankToNull(value)?.replace(/\s+/g, "").toUpperCase() ?? null;

export type ReplyCheck =
  | {
      readonly ok: true;
      readonly fields: ReceiptFields;
      readonly flags: readonly ReceiptFlag[];
    }
  | {
      readonly ok: false;
      readonly reason: "not_a_receipt" | "illegible" | "invalid_reply";
    };

/**
 * Turns Claude's reply into claim fields, or says why it can't. Any value
 * in the wrong shape rejects the whole reply rather than being dropped or
 * repaired: a reply that misreads one field may have misread others.
 */
export function checkReceiptReply(reply: unknown, now: Date): ReplyCheck {
  const parsed = receiptReplySchema.safeParse(reply);
  if (!parsed.success) return { ok: false, reason: "invalid_reply" };
  const read = parsed.data;
  if (!read.readable) {
    return { ok: false, reason: read.unreadableReason ?? "illegible" };
  }

  const merchant = blankToNull(read.merchant);
  const amount = blankToNull(read.amount);
  const date = blankToNull(read.date);
  if (merchant === null && amount === null && date === null) {
    return { ok: false, reason: "illegible" };
  }
  const amountCents = amount === null ? null : decimalToCents(amount);
  if (amount !== null && amountCents === null) {
    return { ok: false, reason: "invalid_reply" };
  }
  if (date !== null && !isPlausibleReceiptDate(date, now)) {
    return { ok: false, reason: "invalid_reply" };
  }

  const values = {
    merchant,
    amount: amountCents,
    currency: compactUpper(read.currency),
    date,
    mpesaCode: compactUpper(read.mpesaCode),
    etimsInvoiceNumber: compactUpper(read.etimsInvoiceNumber),
    supplierKraPin: compactUpper(read.supplierKraPin),
  } satisfies Record<ReceiptFieldName, string | null>;
  const uncertain = new Set(read.uncertainFields);
  const confidence: Partial<Record<ReceiptFieldName, "high" | "low">> = {};
  for (const name of RECEIPT_FIELD_NAMES) {
    if (values[name] !== null) {
      confidence[name] = uncertain.has(name) ? "low" : "high";
    }
  }

  const fields = receiptFieldsSchema.safeParse({
    kind: read.kind,
    merchant: values.merchant,
    amountCents: values.amount,
    currency: values.currency,
    date: values.date,
    mpesaCode: values.mpesaCode,
    etimsInvoiceNumber: values.etimsInvoiceNumber,
    supplierKraPin: values.supplierKraPin,
    confidence,
  });
  if (!fields.success) return { ok: false, reason: "invalid_reply" };
  const flags: ReceiptFlag[] =
    fields.data.amountCents !== null && fields.data.currency !== "KES"
      ? ["currency_not_kes"]
      : [];
  return { ok: true, fields: fields.data, flags };
}
