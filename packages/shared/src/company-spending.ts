import { z } from "zod";

import { billFileRoleSchema } from "./bills.js";
import {
  etimsStatusSchema,
  expenseWarningSchema,
  MAX_RECEIPTS_PER_CLAIM,
  OVERVIEW_HEADINGS,
  submitClaimRequestSchema,
} from "./claims.js";

/**
 * Company spending (spec §6.23): money the company already spent outside
 * Expendi, recorded by an admin with the claim capture flow and the account
 * it was paid from. Always `recorded`; there is no approval or payout.
 */

/** What a paid-from account is, so the accountant can map it in Zoho (spec §6.17). */
export const PAID_FROM_ACCOUNT_KINDS = [
  "bank",
  "card",
  "mobile_money",
  "cash",
  "other",
] as const;
export const paidFromAccountKindSchema = z.enum(PAID_FROM_ACCOUNT_KINDS, {
  error: "Pick bank, card, mobile money, cash or other.",
});
export type PaidFromAccountKind = z.infer<typeof paidFromAccountKindSchema>;

export const PAID_FROM_ACCOUNT_NAME_MAX_LENGTH = 80;

const nameAccount = "Name the account, e.g. KCB current account.";

const accountName = z
  .string({ error: nameAccount })
  .trim()
  .min(1, nameAccount)
  .max(
    PAID_FROM_ACCOUNT_NAME_MAX_LENGTH,
    `Keep the name to ${PAID_FROM_ACCOUNT_NAME_MAX_LENGTH} characters or fewer.`,
  );

export const createPaidFromAccountRequestSchema = z.object({
  name: accountName,
  kind: paidFromAccountKindSchema,
});

export type CreatePaidFromAccountRequest = z.input<
  typeof createPaidFromAccountRequestSchema
>;

/** Renames an account or corrects its kind; a field left out is unchanged. */
export const updatePaidFromAccountRequestSchema = z.object({
  name: accountName.optional(),
  kind: paidFromAccountKindSchema.optional(),
});

export type UpdatePaidFromAccountRequest = z.input<
  typeof updatePaidFromAccountRequestSchema
>;

/** `GET …/paid-from-accounts`: the accounts in use, or `archived=true` for the archived ones. */
export const listPaidFromAccountsQuerySchema = z.object({
  archived: z
    .enum(["true", "false"], { error: "archived is true or false." })
    .transform((value) => value === "true")
    .optional(),
});

export type ListPaidFromAccountsQuery = z.input<
  typeof listPaidFromAccountsQuerySchema
>;

export const paidFromAccountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: paidFromAccountKindSchema,
  /** Archived accounts stay on old spending but can't be picked for new. */
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type PaidFromAccount = z.infer<typeof paidFromAccountSchema>;

/** Sorted by name. */
export const paidFromAccountsResponseSchema = z.array(paidFromAccountSchema);

export type PaidFromAccountsResponse = z.infer<
  typeof paidFromAccountsResponseSchema
>;

/** Short enough to type on a phone, long enough to say something. */
export const NO_RECEIPT_REASON_MIN_LENGTH = 8;
export const NO_RECEIPT_REASON_MAX_LENGTH = 300;

const sayWhyNoReceipt = "Say why there’s no receipt, in a few words.";

const noReceiptReason = z
  .string({ error: sayWhyNoReceipt })
  .trim()
  .min(NO_RECEIPT_REASON_MIN_LENGTH, sayWhyNoReceipt)
  .max(
    NO_RECEIPT_REASON_MAX_LENGTH,
    `Keep the reason to ${NO_RECEIPT_REASON_MAX_LENGTH} characters or fewer.`,
  );

/** Photos, screenshots and at most one pasted M-Pesa SMS; none needs `noReceiptReason`. */
const receiptFileIds = z
  .array(z.uuid({ error: "That receipt isn't available." }))
  .max(
    MAX_RECEIPTS_PER_CLAIM,
    `Add at most ${MAX_RECEIPTS_PER_CLAIM} receipts.`,
  )
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "The same receipt is added twice.",
  );

const overviewHeading = z.enum(OVERVIEW_HEADINGS, {
  error: "That isn't an overview heading.",
});

const paidFromAccountId = z.uuid({
  error: "Pick the account it was paid from.",
});

/** The fields a claim captures, read from a receipt, an SMS or an eTIMS QR the same way. */
const capturedFields = submitClaimRequestSchema.pick({
  merchant: true,
  amountKes: true,
  spentOn: true,
  categoryId: true,
  description: true,
  mpesaCode: true,
  etimsInvoiceNumber: true,
  etimsSupplierPin: true,
  etimsQrPayload: true,
});

/**
 * `POST …/company-spending`. With no receipt, `noReceiptReason` is
 * required and the spending is flagged "no receipt"; with one, it's left
 * out. The heading is Transactions unless the admin picks another.
 */
export const recordCompanySpendingRequestSchema = capturedFields.extend({
  receiptFileIds: receiptFileIds.default([]),
  noReceiptReason: noReceiptReason.nullish(),
  overviewHeading: overviewHeading.optional(),
  paidFromAccountId,
});

export type RecordCompanySpendingRequest = z.input<
  typeof recordCompanySpendingRequestSchema
>;
export type RecordCompanySpendingFields = z.output<
  typeof recordCompanySpendingRequestSchema
>;

/**
 * Changes to company spending. A field left out is unchanged; null clears
 * an optional one. `receiptFileIds` is the full new set. Adding a receipt
 * clears the no-receipt reason. Spending recorded from a bill keeps the
 * bill's amount and date.
 */
export const updateCompanySpendingRequestSchema = capturedFields
  .partial()
  .extend({
    receiptFileIds: receiptFileIds.optional(),
    noReceiptReason: noReceiptReason.nullish(),
    overviewHeading: overviewHeading.optional(),
    paidFromAccountId: paidFromAccountId.optional(),
  });

export type UpdateCompanySpendingRequest = z.input<
  typeof updateCompanySpendingRequestSchema
>;
export type UpdateCompanySpendingFields = z.output<
  typeof updateCompanySpendingRequestSchema
>;

export const COMPANY_SPENDING_PAGE_MAX_SIZE = 100;

/** `GET …/company-spending`: newest date first, a page at a time. Dates are inclusive. */
export const listCompanySpendingQuerySchema = z.object({
  heading: overviewHeading.optional(),
  categoryId: z.uuid({ error: "That category wasn't found." }).optional(),
  paidFromAccountId: z.uuid({ error: "That account wasn't found." }).optional(),
  from: z.iso.date({ error: "from is a date, YYYY-MM-DD." }).optional(),
  to: z.iso.date({ error: "to is a date, YYYY-MM-DD." }).optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COMPANY_SPENDING_PAGE_MAX_SIZE)
    .default(50),
});

export type ListCompanySpendingQuery = z.input<
  typeof listCompanySpendingQuerySchema
>;

export const companySpendingSchema = z.object({
  id: z.uuid(),
  status: z.literal("recorded"),
  overviewHeading: z.enum(OVERVIEW_HEADINGS),
  merchant: z.string(),
  /** KES cents, as a decimal string. */
  amountKes: z.string().regex(/^\d+$/),
  spentOn: z.iso.date(),
  description: z.string().nullable(),
  category: z.object({ id: z.uuid(), name: z.string() }),
  /** Null only when a bill was marked paid without saying from where. */
  paidFromAccount: z
    .object({
      id: z.uuid(),
      name: z.string(),
      kind: paidFromAccountKindSchema,
      archived: z.boolean(),
    })
    .nullable(),
  /** The bill marked paid outside Expendi that recorded this, if any. */
  bill: z
    .object({
      id: z.uuid(),
      payee: z.object({ id: z.uuid(), name: z.string() }),
      reference: z.string().nullable(),
      dueOn: z.iso.date(),
    })
    .nullable(),
  mpesaCode: z.string().nullable(),
  etimsInvoiceNumber: z.string().nullable(),
  etimsSupplierPin: z.string().nullable(),
  etimsQrPayload: z.string().nullable(),
  etimsStatus: etimsStatusSchema,
  /** No receipt on the spending, nor on its bill. */
  noReceipt: z.boolean(),
  /** Why the admin saved it without a receipt. */
  noReceiptReason: z.string().nullable(),
  warnings: z.array(expenseWarningSchema),
  /** Its own receipts plus its bill's invoice and proof. */
  receiptCount: z.number().int().nonnegative(),
  recordedBy: z.object({
    membershipId: z.uuid(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type CompanySpending = z.infer<typeof companySpendingSchema>;

/** `billRole` is set on the bill's own files, which can be PDFs. */
export const companySpendingReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.uuid(),
    kind: z.enum(["photo", "screenshot", "pdf"]),
    billRole: billFileRoleSchema.nullable(),
    contentType: z.string(),
    /** A presigned GET that stops working at `expiresAt`. */
    url: z.url(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    id: z.uuid(),
    kind: z.literal("sms_text"),
    billRole: z.null(),
    text: z.string(),
  }),
]);

export type CompanySpendingReceipt = z.infer<
  typeof companySpendingReceiptSchema
>;

export const companySpendingDetailSchema = companySpendingSchema.extend({
  receipts: z.array(companySpendingReceiptSchema),
});

export type CompanySpendingDetail = z.infer<typeof companySpendingDetailSchema>;

export const companySpendingPageSchema = z.object({
  spending: z.array(companySpendingSchema),
  nextCursor: z.string().nullable(),
});

export type CompanySpendingPage = z.infer<typeof companySpendingPageSchema>;
