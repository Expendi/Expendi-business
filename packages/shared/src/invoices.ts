import { z } from "zod";

import { fundInChainSchema } from "./fund-in.js";

/**
 * Invoices a company sends its customers, paid in USDC through NEAR Intents
 * (docs/decisions/crypto-invoicing.md). Money on the wire is always a
 * string: cents and USDC base units (6 decimals) as integers, quantity as a
 * decimal with up to three places.
 */

export const INVOICE_STATUSES = ["draft", "open", "paid", "void"] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const INVOICE_TERMS = [
  "on_receipt",
  "net_15",
  "net_30",
  "custom",
] as const;
export const invoiceTermsSchema = z.enum(INVOICE_TERMS, {
  error: "Choose when the invoice is due.",
});
export type InvoiceTerms = z.infer<typeof invoiceTermsSchema>;
export const DEFAULT_INVOICE_TERMS: InvoiceTerms = "net_30";

/**
 * - `link`: the customer paid through the invoice's pay link.
 * - `outside`: the admin marked it paid; the money moved outside Expendi.
 * - `matched`: the admin matched a deposit in the company wallet to it.
 */
export const INVOICE_PAYMENT_KINDS = ["link", "outside", "matched"] as const;
export const invoicePaymentKindSchema = z.enum(INVOICE_PAYMENT_KINDS);
export type InvoicePaymentKind = z.infer<typeof invoicePaymentKindSchema>;

export const INVOICE_TERMS_DAYS: Readonly<
  Record<Exclude<InvoiceTerms, "custom">, number>
> = { on_receipt: 0, net_15: 15, net_30: 30 };

/** Most a single line can come to: 15 digits of cents. */
export const MAX_INVOICE_LINE_CENTS = 999_999_999_999_999n;
export const MAX_INVOICE_LINES = 50;

const isoDateSchema = z.iso.date("Use a date like 2026-11-02.");
const centsString = z.string().regex(/^\d{1,18}$/);
const usdcString = z.string().regex(/^\d{1,18}$/);

const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/;
const UNIT_PRICE_PATTERN = /^\d{1,15}$/;
const INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-/_.]*$/;

/** A quantity such as "2.5" in thousandths, exactly. Null if it isn't one. */
export function quantityToMilli(quantity: string): bigint | null {
  if (!QUANTITY_PATTERN.test(quantity)) return null;
  const [whole = "0", fraction = ""] = quantity.split(".");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}

/** quantity × unit price in whole cents, rounded half up, without floats. */
export function lineAmountCents(
  quantity: string,
  unitPriceCents: bigint,
): bigint {
  const milli = quantityToMilli(quantity);
  if (milli === null) throw new RangeError(`bad quantity: ${quantity}`);
  return (milli * unitPriceCents + 500n) / 1000n;
}

// ---- Customers ----

export const customerInputSchema = z.object({
  name: z
    .string({ error: "Enter the customer's name." })
    .trim()
    .min(1, "Enter the customer's name.")
    .max(120, "Keep the name to 120 characters or fewer."),
  email: z
    .string({ error: "Enter the customer's email." })
    .trim()
    .max(254, "That email is too long.")
    .pipe(z.email("Enter a valid email address.")),
  address: z
    .string()
    .trim()
    .max(500, "Keep the address to 500 characters or fewer.")
    .optional(),
  taxId: z
    .string()
    .trim()
    .max(40, "Keep the tax ID to 40 characters or fewer.")
    .optional(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

export const customerUpdateSchema = customerInputSchema.partial().extend({
  archived: z.boolean().optional(),
});
export type CustomerUpdate = z.infer<typeof customerUpdateSchema>;

export const customerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  address: z.string().nullable(),
  taxId: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Customer = z.infer<typeof customerSchema>;

// ---- Draft input ----

export const invoiceLineInputSchema = z
  .object({
    description: z
      .string({ error: "Describe what you are charging for." })
      .trim()
      .min(1, "Describe what you are charging for.")
      .max(300, "Keep the description to 300 characters or fewer."),
    /** Decimal string, up to three places, above zero. */
    quantity: z
      .string({ error: "Enter a quantity." })
      .regex(
        QUANTITY_PATTERN,
        "Enter a quantity with up to 3 decimal places, like 2 or 1.5.",
      )
      .refine((value) => /[1-9]/.test(value), "Enter a quantity above zero."),
    /** Whole cents. */
    unitPriceCents: z
      .string({ error: "Enter a unit price." })
      .regex(UNIT_PRICE_PATTERN, "Enter the unit price in whole cents."),
  })
  .refine(
    (line) =>
      // Field checks don't stop this one, so it must tolerate a bad value.
      !QUANTITY_PATTERN.test(line.quantity) ||
      !UNIT_PRICE_PATTERN.test(line.unitPriceCents) ||
      lineAmountCents(line.quantity, BigInt(line.unitPriceCents)) <=
        MAX_INVOICE_LINE_CENTS,
    {
      error: "That line comes to too much. Check the quantity and price.",
      path: ["unitPriceCents"],
    },
  );
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;

/** The due date the terms give, `YYYY-MM-DD`. A custom date is the one given. */
export function dueOnFor(
  issueOn: string,
  terms: InvoiceTerms,
  dueOn?: string | null,
): string {
  if (terms === "custom") return dueOn ?? issueOn;
  const date = new Date(`${issueOn}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + INVOICE_TERMS_DAYS[terms]);
  return date.toISOString().slice(0, 10);
}

export const invoiceDraftInputSchema = z
  .object({
    customerId: z.uuid("Choose a customer."),
    number: z
      .string({ error: "Enter an invoice number." })
      .trim()
      .min(1, "Enter an invoice number.")
      .max(32, "Keep the invoice number to 32 characters or fewer.")
      .regex(
        INVOICE_NUMBER_PATTERN,
        "Use letters, digits and - / _ . in the invoice number.",
      ),
    issueOn: isoDateSchema,
    terms: invoiceTermsSchema.default(DEFAULT_INVOICE_TERMS),
    dueOn: isoDateSchema.optional(),
    lines: z
      .array(invoiceLineInputSchema)
      .min(1, "Add at least one line.")
      .max(MAX_INVOICE_LINES, `Use ${MAX_INVOICE_LINES} lines or fewer.`),
    /** Basis points: 1600 is 16%. */
    taxRateBps: z
      .number()
      .int("Enter the tax rate as a whole number of basis points.")
      .min(0, "The tax rate can't be negative.")
      .max(10_000, "The tax rate can't be above 100%.")
      .optional(),
    taxLabel: z
      .string()
      .trim()
      .min(1, "Name the tax.")
      .max(20, "Keep the tax name to 20 characters or fewer.")
      .default("VAT"),
    note: z
      .string()
      .trim()
      .max(2000, "Keep the note to 2,000 characters or fewer.")
      .optional(),
  })
  .superRefine((draft, ctx) => {
    if (draft.terms === "custom") {
      if (draft.dueOn === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["dueOn"],
          message: "Choose a due date.",
        });
      } else if (draft.dueOn < draft.issueOn) {
        ctx.addIssue({
          code: "custom",
          path: ["dueOn"],
          message: "The due date can't be before the issue date.",
        });
      }
    } else if (draft.dueOn !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dueOn"],
        message: "Choose custom terms to set a due date.",
      });
    }
  });
/** What a client sends: defaults not yet applied. */
export type InvoiceDraftRequest = z.input<typeof invoiceDraftInputSchema>;
/** What the API receives after parsing. */
export type InvoiceDraftInput = z.output<typeof invoiceDraftInputSchema>;

export const invoiceVoidSchema = z.object({
  reason: z
    .string({ error: "Say why you are voiding the invoice." })
    .trim()
    .min(1, "Say why you are voiding the invoice.")
    .max(500, "Keep the reason to 500 characters or fewer."),
});
export type InvoiceVoidInput = z.infer<typeof invoiceVoidSchema>;

export const invoiceMarkPaidSchema = z.object({
  paidOn: isoDateSchema,
  reference: z
    .string()
    .trim()
    .max(64, "Keep the reference to 64 characters or fewer.")
    .optional(),
  note: z
    .string()
    .trim()
    .max(500, "Keep the note to 500 characters or fewer.")
    .optional(),
});
export type InvoiceMarkPaidInput = z.infer<typeof invoiceMarkPaidSchema>;

export const invoiceMatchSchema = z.object({
  walletTransactionId: z.uuid("Choose a deposit."),
});
export type InvoiceMatchInput = z.infer<typeof invoiceMatchSchema>;

// ---- Responses ----

const partySchema = z.object({
  name: z.string(),
  email: z.string(),
  address: z.string().nullable(),
  taxId: z.string().nullable(),
});

const fromSchema = z.object({
  name: z.string(),
  kraPin: z.string().nullable(),
});

const invoiceLineSchema = z.object({
  id: z.uuid(),
  description: z.string(),
  quantity: z.string(),
  unitPriceCents: centsString,
  amountCents: centsString,
});

/** One list row. `overdue` is an open invoice past its due date in Nairobi. */
export const invoiceSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  customerName: z.string(),
  status: invoiceStatusSchema,
  overdue: z.boolean(),
  totalCents: centsString,
  issueOn: isoDateSchema,
  dueOn: isoDateSchema,
  sentAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const invoicePaymentSchema = z.object({
  id: z.uuid(),
  kind: invoicePaymentKindSchema,
  /** USDC base units received; null for a payment made outside Expendi. */
  amountUsdc: usdcString.nullable(),
  paidOn: isoDateSchema,
  reference: z.string().nullable(),
  note: z.string().nullable(),
  txHash: z.string().nullable(),
  chain: fundInChainSchema.nullable(),
  walletTransactionId: z.uuid().nullable(),
  recordedAt: z.iso.datetime(),
});
export type InvoicePayment = z.infer<typeof invoicePaymentSchema>;

export const invoiceSchema = invoiceSummarySchema.extend({
  customerId: z.uuid(),
  /** The customer as at sending; for a draft, the customer now. */
  billTo: partySchema,
  from: fromSchema,
  terms: invoiceTermsSchema,
  lines: z.array(invoiceLineSchema),
  subtotalCents: centsString,
  taxRateBps: z.number().int().nullable(),
  taxLabel: z.string(),
  taxCents: centsString,
  note: z.string().nullable(),
  publicId: z.string().nullable(),
  voidedReason: z.string().nullable(),
  payments: z.array(invoicePaymentSchema),
});
export type Invoice = z.infer<typeof invoiceSchema>;

/** A deposit in the company wallet that no invoice payment uses yet. */
export const matchableDepositSchema = z.object({
  walletTransactionId: z.uuid(),
  amountUsdc: usdcString,
  receivedAt: z.iso.datetime(),
  from: z.string().nullable(),
  txHash: z.string().nullable(),
});
export type MatchableDeposit = z.infer<typeof matchableDepositSchema>;

// ---- Pay page (no sign-in) ----

export const publicInvoiceSchema = z.object({
  number: z.string(),
  status: z.enum(["open", "paid", "void"]),
  overdue: z.boolean(),
  from: fromSchema,
  billTo: partySchema,
  issueOn: isoDateSchema,
  dueOn: isoDateSchema,
  lines: z.array(invoiceLineSchema),
  subtotalCents: centsString,
  taxRateBps: z.number().int().nullable(),
  taxLabel: z.string(),
  taxCents: centsString,
  totalCents: centsString,
  note: z.string().nullable(),
  chains: z.array(fundInChainSchema),
  /** False when the invoice isn't open or the company can't take payments. */
  canPay: z.boolean(),
});
export type PublicInvoice = z.infer<typeof publicInvoiceSchema>;

export const invoicePayQuoteRequestSchema = z.object({
  chain: fundInChainSchema,
});
export type InvoicePayQuoteRequest = z.infer<
  typeof invoicePayQuoteRequestSchema
>;

export const PUBLIC_PAY_QUOTE_STATUSES = [
  "awaiting_deposit",
  "processing",
  "paid",
  "needs_attention",
  "expired",
] as const;

export const publicPayQuoteSchema = z.object({
  id: z.uuid(),
  chain: fundInChainSchema,
  /** USDC base units to send to the deposit address. */
  amountIn: usdcString,
  depositAddress: z.string(),
  deadline: z.iso.datetime(),
  status: z.enum(PUBLIC_PAY_QUOTE_STATUSES),
});
export type PublicPayQuote = z.infer<typeof publicPayQuoteSchema>;

// ---- Numbering ----

/**
 * The next number after the company's: `INV-` and the highest trailing
 * integer plus one, padded to four digits.
 */
export function suggestNextInvoiceNumber(existing: readonly string[]): string {
  let highest = 0;
  for (const number of existing) {
    const trailing = /(\d+)$/.exec(number)?.[1];
    if (trailing === undefined) continue;
    const value = Number(trailing);
    if (Number.isSafeInteger(value) && value > highest) highest = value;
  }
  return `INV-${String(highest + 1).padStart(4, "0")}`;
}
