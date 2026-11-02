import { z } from "zod";

import { ETIMS_QR_MAX_BYTES, etimsQrByteLength } from "./etims-qr.js";
import { parseKesToCents } from "./kes-amount.js";
import { KRA_PIN_PATTERN } from "./organization.js";
import { payoutStatusSchema } from "./wallet-history.js";

/**
 * Money out recorded with a receipt (spec §5): a staff claim, spending from
 * a petty cash float, or company spending paid outside Expendi.
 */
export const EXPENSE_KINDS = ["claim", "float", "company"] as const;
export const expenseKindSchema = z.enum(EXPENSE_KINDS);
export type ExpenseKind = z.infer<typeof expenseKindSchema>;

/** The spending overview's four headings (spec §5, §6.24). */
export const OVERVIEW_HEADINGS = [
  "petty_cash",
  "transactions",
  "salaries",
  "subscriptions",
] as const;
export type OverviewHeading = (typeof OVERVIEW_HEADINGS)[number];

/** `import` rows come from the one-time spreadsheet import (spec §6.12). */
export const EXPENSE_SOURCES = ["app", "import"] as const;
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

/**
 * Claim statuses (spec §5). `paid_outside` is imported history and
 * `recorded` is float or company spending; neither is ever approved or paid.
 */
export const EXPENSE_STATUSES = [
  "submitted",
  "rejected",
  "paying",
  "paid",
  "payout_failed",
  "paid_outside",
  "recorded",
] as const;
export const expenseStatusSchema = z.enum(EXPENSE_STATUSES);
export type ExpenseStatus = z.infer<typeof expenseStatusSchema>;

/** The person who submitted a claim can change it only until it's approved. */
export const EDITABLE_CLAIM_STATUSES = [
  "submitted",
  "rejected",
] as const satisfies readonly ExpenseStatus[];

/** spec §6.6 */
export const ETIMS_STATUSES = ["attached", "not_required", "none"] as const;
export const etimsStatusSchema = z.enum(ETIMS_STATUSES);
export type EtimsStatus = z.infer<typeof etimsStatusSchema>;

/** `pdf` is a bill's invoice; claims never take one. */
export const RECEIPT_FILE_KINDS = [
  "photo",
  "screenshot",
  "sms_text",
  "pdf",
] as const;
export const receiptFileKindSchema = z.enum(RECEIPT_FILE_KINDS);
export type ReceiptFileKind = z.infer<typeof receiptFileKindSchema>;

/** The app shrinks photos to JPEG, but a picked screenshot can be any of these. */
export const RECEIPT_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;
export type ReceiptImageType = (typeof RECEIPT_IMAGE_TYPES)[number];

export const RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_RECEIPTS_PER_CLAIM = 5;
export const MERCHANT_MAX_LENGTH = 120;
export const CLAIM_DESCRIPTION_MAX_LENGTH = 500;
export const ETIMS_INVOICE_NUMBER_MAX_LENGTH = 64;
/** KES 100,000,000.00: far above any real expense, so a typo can't go through. */
export const MAX_EXPENSE_KES_CENTS = 10_000_000_000n;

/** An M-Pesa transaction code: 10 letters and digits, e.g. SLK4H7Q2XY. */
export const MPESA_CODE_PATTERN = /^[A-Z0-9]{10}$/;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const receiptUploadRequestSchema = z.object({
  contentType: z.enum(RECEIPT_IMAGE_TYPES, {
    error: "Upload a JPEG, PNG, WebP or HEIC image.",
  }),
  byteSize: z
    .int({ error: "Send the image's size in bytes." })
    .positive("That image is empty.")
    .max(RECEIPT_MAX_BYTES, "That image is too large. Keep it under 8 MB."),
  /** Hex SHA-256 of the exact bytes being uploaded. */
  sha256: z
    .string({ error: "Send the image's SHA-256." })
    .trim()
    .toLowerCase()
    .regex(SHA256_HEX, "That isn't a SHA-256 hash."),
  kind: z.enum(["photo", "screenshot"]).default("photo"),
});

export type ReceiptUploadRequest = z.input<typeof receiptUploadRequestSchema>;

export const receiptUploadResponseSchema = z.object({
  receiptFileId: z.uuid(),
  /**
   * A presigned PUT. Send the file with exactly the requested
   * `Content-Type`, and its size as `Content-Length`.
   */
  uploadUrl: z.url(),
  /** `org/<organizationId>/receipts/<uuid>.<ext>` in the private bucket. */
  storageKey: z.string(),
  expiresAt: z.iso.datetime(),
});

export type ReceiptUploadResponse = z.infer<typeof receiptUploadResponseSchema>;

/** Several confirmations pasted together still fit; one SMS is about 300 characters. */
export const MPESA_SMS_MAX_LENGTH = 2000;

const pasteSms = "Paste the M-Pesa SMS.";

/** A pasted M-Pesa payment SMS, kept as the claim's evidence (spec §6.4). */
export const receiptSmsRequestSchema = z.object({
  text: z
    .string({ error: pasteSms })
    .trim()
    .min(1, pasteSms)
    .max(
      MPESA_SMS_MAX_LENGTH,
      "That's too long for an M-Pesa SMS. Paste just the payment message.",
    ),
});

export type ReceiptSmsRequest = z.input<typeof receiptSmsRequestSchema>;

/** What the API read from the SMS; the claim must agree with it. */
export const receiptSmsResponseSchema = z.object({
  receiptFileId: z.uuid(),
  sms: z.object({
    kind: z.enum(["buy_goods", "send_money", "paybill"]),
    code: z.string(),
    /** KES cents, as a decimal string. */
    amountKesCents: z.string().regex(/^\d+$/),
    counterparty: z.string(),
    /** ISO 8601 in Nairobi time. */
    occurredAt: z.string(),
  }),
});

export type ReceiptSmsResponse = z.infer<typeof receiptSmsResponseSchema>;

/** The claim fields reading a receipt photo can fill in (spec §6.4). */
export const EXTRACTED_CLAIM_FIELDS = [
  "merchant",
  "amountKes",
  "spentOn",
  "mpesaCode",
  "etimsInvoiceNumber",
  "etimsSupplierPin",
] as const;
export type ExtractedClaimField = (typeof EXTRACTED_CLAIM_FIELDS)[number];

/**
 * What reading an uploaded receipt image found, only to pre-fill the form:
 * the employee always checks it before submitting. `unreadable` covers
 * every reason it couldn't be read, so the app falls back to manual entry.
 */
export const receiptExtractionResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("read"),
    fields: z.object({
      merchant: z.string().nullable(),
      /** KES cents, as a decimal string; null when not shown or not in KES. */
      amountKes: z.string().regex(/^\d+$/).nullable(),
      spentOn: z.iso.date().nullable(),
      mpesaCode: z.string().nullable(),
      etimsInvoiceNumber: z.string().nullable(),
      etimsSupplierPin: z.string().nullable(),
    }),
    /** Filled-in fields that were hard to read; the app highlights them. */
    lowConfidence: z.array(z.enum(EXTRACTED_CLAIM_FIELDS)),
    /** The receipt shows an amount in another currency, left out of `amountKes`. */
    amountNotInKes: z.boolean(),
  }),
  z.object({ status: z.literal("unreadable") }),
]);

export type ReceiptExtractionResponse = z.infer<
  typeof receiptExtractionResponseSchema
>;

const enterAmount = "Enter the amount in KES, like 1,500 or 1500.50.";

/** KES as typed, e.g. "1,500.50", parsed to integer cents without floats. */
export const kesAmountSchema = z
  .string({ error: enterAmount })
  .transform((value, ctx) => {
    const cents = parseKesToCents(value);
    if (cents === null) {
      ctx.addIssue(enterAmount);
      return z.NEVER;
    }
    if (cents <= 0n) {
      ctx.addIssue("Enter an amount above zero.");
      return z.NEVER;
    }
    if (cents > MAX_EXPENSE_KES_CENTS) {
      ctx.addIssue("That amount is too large. Check it and try again.");
      return z.NEVER;
    }
    return cents;
  });

const enterMerchant = "Enter where you paid.";
const enterDescription = "Say what this was for.";

const addEvidence =
  "Add a photo or screenshot of the receipt, or paste the M-Pesa SMS.";

const claimFields = {
  /** Photos, screenshots and at most one pasted M-Pesa SMS (spec §6.5). */
  receiptFileIds: z
    .array(z.uuid({ error: "That receipt isn't available." }), {
      error: addEvidence,
    })
    .min(1, addEvidence)
    .max(
      MAX_RECEIPTS_PER_CLAIM,
      `Add at most ${MAX_RECEIPTS_PER_CLAIM} receipts.`,
    )
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "The same receipt is added twice.",
    ),
  merchant: z
    .string({ error: enterMerchant })
    .trim()
    .min(1, enterMerchant)
    .max(
      MERCHANT_MAX_LENGTH,
      `Keep the merchant to ${MERCHANT_MAX_LENGTH} characters or fewer.`,
    ),
  amountKes: kesAmountSchema,
  spentOn: z.iso.date({ error: "Enter the date you paid." }),
  categoryId: z.uuid({ error: "Pick a category." }),
  description: z
    .string({ error: enterDescription })
    .trim()
    .min(1, enterDescription)
    .max(
      CLAIM_DESCRIPTION_MAX_LENGTH,
      `Keep the description to ${CLAIM_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    ),
  mpesaCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      MPESA_CODE_PATTERN,
      "An M-Pesa code is 10 letters and numbers, like SLK4H7Q2XY.",
    )
    .nullish(),
  etimsInvoiceNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Enter the eTIMS invoice number, or leave it out.")
    .max(
      ETIMS_INVOICE_NUMBER_MAX_LENGTH,
      "That eTIMS invoice number is too long.",
    )
    .nullish(),
  /** The supplier's KRA PIN from the eTIMS invoice. */
  etimsSupplierPin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      KRA_PIN_PATTERN,
      "That isn't a valid KRA PIN. It's A or P, then 9 digits and a letter.",
    )
    .nullish(),
  /**
   * The receipt's eTIMS QR code exactly as scanned. The API reads the
   * invoice number and supplier PIN from it, and refuses typed ones that
   * contradict it.
   */
  etimsQrPayload: z
    .string()
    .trim()
    .min(1, "Scan the eTIMS QR code again, or leave it out.")
    .refine(
      (payload) => etimsQrByteLength(payload) <= ETIMS_QR_MAX_BYTES,
      "That QR code is too long to be an eTIMS receipt.",
    )
    .nullish(),
};

/**
 * A new claim (spec §6.3). The optional M-Pesa and eTIMS fields can be left
 * out or sent as null.
 */
export const submitClaimRequestSchema = z.object(claimFields);

/** What the app sends: the amount as typed, e.g. "1,500.50". */
export type SubmitClaimRequest = z.input<typeof submitClaimRequestSchema>;
/** What the API stores: the amount in integer KES cents. */
export type SubmitClaimFields = z.output<typeof submitClaimRequestSchema>;

/**
 * Changes to the caller's own claim while it's submitted or rejected. A
 * field left out is unchanged; null clears an optional one. `receiptFileIds`
 * is the claim's full new set. Editing a rejected claim resubmits it.
 */
export const updateClaimRequestSchema = z.object(claimFields).partial();

export type UpdateClaimRequest = z.input<typeof updateClaimRequestSchema>;
export type UpdateClaimFields = z.output<typeof updateClaimRequestSchema>;

export const CLAIMS_PAGE_MAX_SIZE = 50;

export const claimListQuerySchema = z.object({
  status: expenseStatusSchema.optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(CLAIMS_PAGE_MAX_SIZE).default(20),
});

export type ClaimListQuery = z.input<typeof claimListQuerySchema>;

/** An expense dated more than this many days before it's recorded gets a warning. */
export const STALE_EXPENSE_DAYS = 60;

/**
 * Something for the admin to check before approving (spec §6.5). Stored on
 * the expense when it's recorded or edited.
 */
export const expenseWarningSchema = z.discriminatedUnion("code", [
  z.object({
    /** The same person, the same amount, a day apart or less. */
    code: z.literal("near_duplicate"),
    expenseId: z.uuid(),
    spentOn: z.iso.date(),
    /** KES cents, as a decimal string. */
    amountKes: z.string().regex(/^\d+$/),
  }),
  z.object({
    /** Dated more than `STALE_EXPENSE_DAYS` before it was recorded, in Nairobi. */
    code: z.literal("older_than_60_days"),
    spentOn: z.iso.date(),
    ageDays: z.number().int().positive(),
  }),
]);

export type ExpenseWarning = z.infer<typeof expenseWarningSchema>;

/**
 * The `details` of a 409 for an exact duplicate (spec §6.5): the earlier
 * record's date and amount, and its ID only when the caller can open it.
 */
export const duplicateOfSchema = z.object({
  expenseId: z.uuid().nullable(),
  kind: expenseKindSchema,
  spentOn: z.iso.date(),
  /** KES cents, as a decimal string. */
  amountKes: z.string().regex(/^\d+$/),
  yours: z.boolean(),
});

export type DuplicateOf = z.infer<typeof duplicateOfSchema>;

export const claimSchema = z.object({
  id: z.uuid(),
  status: expenseStatusSchema,
  merchant: z.string(),
  /** KES cents, as a decimal string. */
  amountKes: z.string().regex(/^\d+$/),
  spentOn: z.iso.date(),
  /** Null only for imported history. */
  description: z.string().nullable(),
  category: z.object({ id: z.uuid(), name: z.string() }),
  mpesaCode: z.string().nullable(),
  etimsInvoiceNumber: z.string().nullable(),
  etimsSupplierPin: z.string().nullable(),
  etimsQrPayload: z.string().nullable(),
  etimsStatus: etimsStatusSchema,
  rejectedReason: z.string().nullable(),
  submittedBy: z.object({
    membershipId: z.uuid(),
    name: z.string().nullable(),
    email: z.string(),
    /** Whether they've confirmed an M-Pesa payout number; Approve & pay waits for it (spec §6.18). */
    payoutPhoneConfirmed: z.boolean(),
  }),
  /** When an admin last approved it for payment. */
  approvedAt: z.iso.datetime().nullable(),
  /** The claimant approved it themselves (spec §4); flagged in the audit log and the export. */
  selfApproved: z.boolean(),
  paidAt: z.iso.datetime().nullable(),
  /** The caller's own claim, still `submitted` or `rejected`. */
  canEdit: z.boolean(),
  /** For admins only; always empty for anyone else. */
  warnings: z.array(expenseWarningSchema),
  receiptCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Claim = z.infer<typeof claimSchema>;

/** An image in storage, or a pasted M-Pesa SMS kept as text. */
export const claimReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.uuid(),
    kind: z.enum(["photo", "screenshot"]),
    contentType: z.string(),
    /** A presigned GET that stops working at `expiresAt`. */
    url: z.url(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    id: z.uuid(),
    kind: z.literal("sms_text"),
    text: z.string(),
  }),
]);

export type ClaimReceipt = z.infer<typeof claimReceiptSchema>;

export const claimDetailSchema = claimSchema.extend({
  receipts: z.array(claimReceiptSchema),
  /** The latest payment of the claim, for admins only; null for anyone else. */
  payout: z
    .object({
      id: z.uuid(),
      status: payoutStatusSchema,
      failureReason: z.string().nullable(),
    })
    .nullable(),
});

export type ClaimDetail = z.infer<typeof claimDetailSchema>;

/** Newest first. Employees get only their own claims; admins get everyone's. */
export const claimsPageSchema = z.object({
  claims: z.array(claimSchema),
  nextCursor: z.string().nullable(),
});

export type ClaimsPage = z.infer<typeof claimsPageSchema>;
