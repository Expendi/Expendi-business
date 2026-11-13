import { z } from "zod";

import type { OverviewHeading } from "./claims.js";
import type { PayeeKind, PayeeMethod } from "./payee.js";
import { paymentReceiptsSchema } from "./cash-out-receipt.js";
import {
  kesAmountSchema,
  OVERVIEW_HEADINGS,
  RECEIPT_IMAGE_TYPES,
  RECEIPT_MAX_BYTES,
  receiptFileKindSchema,
} from "./claims.js";
import { parseUsdToUsdcUnits } from "./kes-amount.js";
import { PAYEE_METHODS, payeeKindSchema, payeeMethodSchema } from "./payee.js";
import {
  RECURRING_ITEM_STATES,
  recurringScheduleSchema,
} from "./recurring-schedule.js";
import { payoutStatusSchema } from "./wallet-history.js";

/** Bill statuses (spec §6.20). */
export const BILL_STATUSES = [
  "upcoming",
  "due",
  "overdue",
  "paying",
  "paid",
  "payout_failed",
  "paid_outside",
  "cancelled",
] as const;
export const billStatusSchema = z.enum(BILL_STATUSES, {
  error:
    "A bill status is upcoming, due, overdue, paying, paid, payout_failed, paid_outside or cancelled.",
});
export type BillStatus = z.infer<typeof billStatusSchema>;

/**
 * What a bill's amount is in (spec §6.19): KES, or USD for a payee paid in
 * USDC, whose bill pays exactly that many USDC.
 */
export const BILL_CURRENCIES = ["kes", "usd"] as const;
export const billCurrencySchema = z.enum(BILL_CURRENCIES);
export type BillCurrency = z.infer<typeof billCurrencySchema>;

/**
 * The currency a payee's bills are entered in: USD for a payee paid in
 * USDC, KES for everyone else, including a payee with no details yet.
 */
export function currencyForPayeeMethod(
  method: PayeeMethod | null,
): BillCurrency {
  return method === "usdc" ? "usd" : "kes";
}

/** The most a USD bill can be: USD 10,000,000, in USDC base units. */
export const MAX_BILL_USDC_UNITS = 10_000_000_000_000n;

const enterUsd = "Enter the amount in USD, like 1,500 or 1500.50.";

/** USD as typed, e.g. "1,500.50", parsed to USDC base units without floats. */
export const usdAmountSchema = z
  .string({ error: enterUsd })
  .transform((value, ctx) => {
    const units = parseUsdToUsdcUnits(value);
    if (units === null) {
      ctx.addIssue(enterUsd);
      return z.NEVER;
    }
    if (units <= 0n) {
      ctx.addIssue("Enter an amount above zero.");
      return z.NEVER;
    }
    if (units > MAX_BILL_USDC_UNITS) {
      ctx.addIssue("That amount is too large. Check it and try again.");
      return z.NEVER;
    }
    return units;
  });

/**
 * Not paid and no payment in progress: the admin can still change the
 * bill, pay it, mark it paid outside or cancel it.
 */
export const UNPAID_BILL_STATUSES = [
  "upcoming",
  "due",
  "overdue",
  "payout_failed",
] as const satisfies readonly BillStatus[];

/** The statuses that follow the due date; the daily job never touches any other. */
export const DATED_BILL_STATUSES = [
  "upcoming",
  "due",
  "overdue",
] as const satisfies readonly BillStatus[];
export type DatedBillStatus = (typeof DATED_BILL_STATUSES)[number];

/** Settled for good: paid through Expendi, paid outside it, or cancelled. */
export const SETTLED_BILL_STATUSES = [
  "paid",
  "paid_outside",
  "cancelled",
] as const satisfies readonly BillStatus[];

/**
 * The Bills page's tabs, by the bill's stage: still to pay, being paid,
 * then history.
 */
export const BILL_LIST_VIEWS = ["open", "paying", "history"] as const;
export const billListViewSchema = z.enum(BILL_LIST_VIEWS, {
  error: "view is open, paying or history.",
});
export type BillListView = z.infer<typeof billListViewSchema>;

export const BILL_LIST_VIEW_STATUSES = {
  open: UNPAID_BILL_STATUSES,
  paying: ["paying"],
  history: SETTLED_BILL_STATUSES,
} as const satisfies Readonly<Record<BillListView, readonly BillStatus[]>>;

/** Created by a recurring payment, or entered once by hand. */
export const BILL_SOURCES = ["recurring", "one_off"] as const;
export type BillSource = (typeof BILL_SOURCES)[number];

/** How the payee is paid, or `none` while they have no payment details. */
export const BILL_METHOD_FILTERS = [...PAYEE_METHODS, "none"] as const;
export type BillMethodFilter = (typeof BILL_METHOD_FILTERS)[number];

/**
 * Where a bill sits in the overview (spec §5): Transactions or
 * Subscriptions. Salary bills belong to payroll runs (T38).
 */
export const BILL_HEADINGS = [
  "transactions",
  "subscriptions",
] as const satisfies readonly OverviewHeading[];
export const billHeadingSchema = z.enum(BILL_HEADINGS, {
  error: "Pick Transactions or Subscriptions.",
});
export type BillHeading = z.infer<typeof billHeadingSchema>;

/** Subscription vendors default to Subscriptions; everyone else, statutory bodies included, to Transactions. */
export function defaultBillHeading(kind: PayeeKind): BillHeading {
  return kind === "vendor" ? "subscriptions" : "transactions";
}

/** What a file on a bill is: the supplier's invoice, or proof it was paid outside Expendi. */
export const BILL_FILE_ROLES = ["invoice", "proof"] as const;
export const billFileRoleSchema = z.enum(BILL_FILE_ROLES);
export type BillFileRole = z.infer<typeof billFileRoleSchema>;

/** An invoice can be a PDF as well as an image; claims stay image-only. */
export const BILL_FILE_TYPES = [
  ...RECEIPT_IMAGE_TYPES,
  "application/pdf",
] as const;
export type BillFileType = (typeof BILL_FILE_TYPES)[number];

export const BILL_REFERENCE_MAX_LENGTH = 64;
export const BILL_NOTES_MAX_LENGTH = 500;
export const BILL_REASON_MAX_LENGTH = 300;
export const MAX_BILL_FILES_PER_REQUEST = 5;
export const BILLS_LIST_MAX_SIZE = 500;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `POST …/bills/upload-url`: like a receipt upload, but a PDF is allowed too. */
export const billUploadRequestSchema = z.object({
  contentType: z.enum(BILL_FILE_TYPES, {
    error: "Upload a PDF, or a JPEG, PNG, WebP or HEIC image.",
  }),
  byteSize: z
    .int({ error: "Send the file's size in bytes." })
    .positive("That file is empty.")
    .max(RECEIPT_MAX_BYTES, "That file is too large. Keep it under 8 MB."),
  sha256: z
    .string({ error: "Send the file's SHA-256." })
    .trim()
    .toLowerCase()
    .regex(SHA256_HEX, "That isn't a SHA-256 hash."),
});

export type BillUploadRequest = z.input<typeof billUploadRequestSchema>;

/** Blank text is stored as null; null clears the field on an edit. */
function optionalText(maxLength: number, tooLong: string) {
  return z
    .string()
    .trim()
    .max(maxLength, tooLong)
    .transform((value) => (value === "" ? null : value))
    .nullish();
}

const reference = optionalText(
  BILL_REFERENCE_MAX_LENGTH,
  `Keep the reference to ${BILL_REFERENCE_MAX_LENGTH} characters or fewer.`,
);
const notes = optionalText(
  BILL_NOTES_MAX_LENGTH,
  `Keep the notes to ${BILL_NOTES_MAX_LENGTH} characters or fewer.`,
);

function reasonSchema(missing: string) {
  return z
    .string({ error: missing })
    .trim()
    .min(1, missing)
    .max(
      BILL_REASON_MAX_LENGTH,
      `Keep the reason to ${BILL_REASON_MAX_LENGTH} characters or fewer.`,
    );
}

const fileIds = z
  .array(z.uuid({ error: "That file isn't available." }))
  .max(
    MAX_BILL_FILES_PER_REQUEST,
    `Add at most ${MAX_BILL_FILES_PER_REQUEST} files at a time.`,
  )
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "The same file is added twice.",
  );

const dueOn = z.iso.date({ error: "Enter the due date as YYYY-MM-DD." });

const oneCurrency = {
  message: "Enter the amount in KES or in USD, not both.",
  path: ["amountUsd"],
};

/**
 * A one-off bill (spec §6.20). A variable bill (e.g. PAYE or electricity)
 * can be saved without its amount, which is entered before it's paid.
 * The amount is in KES, or in USD (`amountUsd`) when the payee is paid in
 * USDC (spec §6.19); the API checks which. The heading defaults from the
 * payee: Subscriptions for a subscription vendor, Transactions otherwise.
 */
export const createBillRequestSchema = z
  .object({
    payeeId: z.uuid({ error: "Pick who the bill is for." }),
    variable: z.boolean().default(false),
    amountKes: kesAmountSchema.nullish(),
    amountUsd: usdAmountSchema.nullish(),
    dueOn,
    overviewHeading: billHeadingSchema.optional(),
    categoryId: z.uuid({ error: "Pick a category." }),
    reference,
    notes,
    /** Uploaded invoices to attach. */
    invoiceFileIds: fileIds.default([]),
  })
  .refine(
    (bill) => bill.variable || bill.amountKes != null || bill.amountUsd != null,
    {
      message: "Enter the amount, or mark the bill as variable.",
      path: ["amountKes"],
    },
  )
  .refine(
    (bill) => bill.amountKes == null || bill.amountUsd == null,
    oneCurrency,
  );

export type CreateBillRequest = z.input<typeof createBillRequestSchema>;
export type CreateBillFields = z.output<typeof createBillRequestSchema>;

/**
 * Changes to an unpaid bill. A field left out is unchanged; null clears
 * the reference, the notes, or a variable bill's amount. Changing a fixed
 * bill's amount needs `adjustmentReason`. The amount goes in `amountUsd`
 * for a payee paid in USDC; a new payee paid in the other currency needs
 * the amount again in theirs.
 */
export const updateBillRequestSchema = z
  .object({
    payeeId: z.uuid({ error: "Pick who the bill is for." }).optional(),
    amountKes: kesAmountSchema.nullable().optional(),
    amountUsd: usdAmountSchema.nullable().optional(),
    dueOn: dueOn.optional(),
    overviewHeading: billHeadingSchema.optional(),
    categoryId: z.uuid({ error: "Pick a category." }).optional(),
    reference,
    notes,
    adjustmentReason: reasonSchema("Say why the amount changed.").optional(),
  })
  .refine(
    (bill) => bill.amountKes === undefined || bill.amountUsd === undefined,
    oneCurrency,
  );

export type UpdateBillRequest = z.input<typeof updateBillRequestSchema>;
export type UpdateBillFields = z.output<typeof updateBillRequestSchema>;

export const attachBillFilesRequestSchema = z.object({
  receiptFileIds: fileIds.min(1, "Add the invoice."),
});

export type AttachBillFilesRequest = z.input<
  typeof attachBillFilesRequestSchema
>;

/**
 * The admin records a bill paid outside Expendi, optionally with proof.
 * It also records the bill as company spending (spec §6.23), paid from
 * `paidFromAccountId`; left out, the account is "not specified" until the
 * admin edits that spending.
 */
export const markBillPaidOutsideRequestSchema = z.object({
  paidOn: z.iso.date({ error: "Enter the date it was paid as YYYY-MM-DD." }),
  note: notes,
  receiptFileIds: fileIds.default([]),
  paidFromAccountId: z
    .uuid({ error: "Pick the account it was paid from." })
    .nullish(),
});

export type MarkBillPaidOutsideRequest = z.input<
  typeof markBillPaidOutsideRequestSchema
>;
export type MarkBillPaidOutsideFields = z.output<
  typeof markBillPaidOutsideRequestSchema
>;

export const cancelBillRequestSchema = z.object({
  reason: reasonSchema("Say why this bill won't be paid."),
});

export type CancelBillRequest = z.input<typeof cancelBillRequestSchema>;

/**
 * The filters `GET …/bills` and `GET …/bills/summary` share.
 * `settledFrom` leaves out bills settled before that Nairobi day (paid,
 * or cancelled), keeping every bill not yet settled.
 */
const billFilterFields = {
  heading: z
    .enum(OVERVIEW_HEADINGS, { error: "That isn't an overview heading." })
    .optional(),
  payeeId: z.uuid({ error: "That payee wasn't found." }).optional(),
  categoryId: z.uuid({ error: "That category wasn't found." }).optional(),
  method: z
    .enum(BILL_METHOD_FILTERS, {
      error:
        "method is mpesa_phone, mpesa_till, mpesa_paybill, bank, usdc, outside or none.",
    })
    .optional(),
  source: z
    .enum(BILL_SOURCES, { error: "source is recurring or one_off." })
    .optional(),
  dueFrom: z.iso.date({ error: "dueFrom is a date, YYYY-MM-DD." }).optional(),
  dueTo: z.iso.date({ error: "dueTo is a date, YYYY-MM-DD." }).optional(),
  settledFrom: z.iso
    .date({ error: "settledFrom is a date, YYYY-MM-DD." })
    .optional(),
};

/**
 * `GET …/bills` filters. `status` takes several statuses separated by
 * commas, e.g. `overdue,due,upcoming`, and narrows `view` when both are
 * given. Salary bills are listed unless `excludePayroll=true`: the Bills
 * page leaves them to Payroll. Bills come sorted by due date, earliest
 * first.
 */
export const listBillsQuerySchema = z.object({
  view: billListViewSchema.optional(),
  status: z
    .string()
    .transform((value) => value.split(",").map((part) => part.trim()))
    .pipe(z.array(billStatusSchema))
    .optional(),
  ...billFilterFields,
  excludePayroll: z
    .enum(["true", "false"], { error: "excludePayroll is true or false." })
    .transform((value) => value === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(BILLS_LIST_MAX_SIZE).default(200),
});

export type ListBillsQuery = z.input<typeof listBillsQuerySchema>;

/** `GET …/bills/summary`: the list's filters, without a tab or status. */
export const billsSummaryQuerySchema = z.object(billFilterFields);

export type BillsSummaryQuery = z.input<typeof billsSummaryQuerySchema>;

const billPersonSchema = z.object({
  userId: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
});

export const billSchema = z.object({
  id: z.uuid(),
  status: billStatusSchema,
  payee: z.object({
    id: z.uuid(),
    name: z.string(),
    kind: payeeKindSchema,
    /** Null until the payee's payment details are added. */
    method: payeeMethodSchema.nullable(),
    archived: z.boolean(),
  }),
  overviewHeading: z.enum(OVERVIEW_HEADINGS),
  category: z.object({ id: z.uuid(), name: z.string() }),
  /** The amount is entered each time, e.g. PAYE or electricity. */
  variable: z.boolean(),
  /** USD for a payee paid in USDC, whose bill pays exactly `amountUsdc`. */
  currency: billCurrencySchema,
  /** KES cents as a decimal string; null on a variable bill until it's entered, and on a USD bill. */
  amountKes: z.string().regex(/^\d+$/).nullable(),
  /** A USD bill's amount in USDC base units (6 decimals); null otherwise. */
  amountUsdc: z.string().regex(/^\d+$/).nullable(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  dueOn: z.iso.date(),
  recurringItemId: z.uuid().nullable(),
  payrollRunId: z.uuid().nullable(),
  /** Why a fixed amount was last changed; earlier reasons stay in the audit log. */
  adjustmentReason: z.string().nullable(),
  /** The Kenyan calendar day it was paid, through Expendi or outside it. */
  paidOn: z.iso.date().nullable(),
  /** When Expendi recorded it as paid. */
  paidAt: z.iso.datetime().nullable(),
  markedPaidBy: billPersonSchema.nullable(),
  paidOutsideNote: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledBy: billPersonSchema.nullable(),
  payoutId: z.uuid().nullable(),
  /**
   * Its cash-outs' receipts once paid through Expendi; a split salary has
   * several.
   */
  paymentReceipts: paymentReceiptsSchema,
  fileCount: z.number().int().nonnegative(),
  /**
   * The recurring payment that created it, enough to describe its schedule
   * (`describeSchedule`) and link to it; null on a one-off bill. Always
   * sent; optional only for clients built before it.
   */
  recurring: z
    .object({
      id: z.uuid(),
      state: z.enum(RECURRING_ITEM_STATES),
      schedule: recurringScheduleSchema,
      scheduleDay: z.int(),
      startsOn: z.iso.date(),
    })
    .nullish(),
  /**
   * A bill marked paid outside Expendi: the account its company spending
   * says it was paid from, until then or when not given null. Always sent;
   * optional only for clients built before it.
   */
  paidFromAccount: z.object({ id: z.uuid(), name: z.string() }).nullish(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Bill = z.infer<typeof billSchema>;

export const billFileSchema = z.object({
  id: z.uuid(),
  role: billFileRoleSchema,
  kind: receiptFileKindSchema,
  contentType: z.string(),
  /** A presigned GET that stops working at `expiresAt`. */
  url: z.url(),
  expiresAt: z.iso.datetime(),
});

export type BillFile = z.infer<typeof billFileSchema>;

export const billDetailSchema = billSchema.extend({
  files: z.array(billFileSchema),
  /**
   * Its latest payment through Expendi, e.g. why it failed; null when it
   * was never paid through Expendi. Always sent; optional only for clients
   * built before it.
   */
  payout: z
    .object({
      id: z.uuid(),
      status: payoutStatusSchema,
      failureReason: z.string().nullable(),
    })
    .nullish(),
});

export type BillDetail = z.infer<typeof billDetailSchema>;

export const billsResponseSchema = z.array(billSchema);

export type BillsResponse = z.infer<typeof billsResponseSchema>;

const billTotalsSchema = z.object({
  count: z.number().int().nonnegative(),
  /** The KES bills' amounts, in KES cents. */
  totalKes: z.string().regex(/^\d+$/),
  /** The USD bills' amounts, in USDC base units, for the dashboard to convert at today's rate. */
  totalUsdc: z.string().regex(/^\d+$/),
});

/**
 * `GET …/bills/summary`, never counting salary bills. `views` follows the
 * filters; the rest is company-wide whatever the filters, over the bills
 * still to pay.
 */
export const billsSummarySchema = z.object({
  /** How many bills each tab holds. */
  views: z.object({
    open: z.number().int().nonnegative(),
    paying: z.number().int().nonnegative(),
    history: z.number().int().nonnegative(),
  }),
  /** Every unpaid bill; `withoutAmount` of them wait for their amount. */
  toPay: billTotalsSchema.extend({
    withoutAmount: z.number().int().nonnegative(),
  }),
  overdue: billTotalsSchema,
  dueToday: billTotalsSchema,
  payoutFailed: billTotalsSchema,
});

export type BillsSummary = z.infer<typeof billsSummarySchema>;
