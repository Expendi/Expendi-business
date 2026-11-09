import { z } from "zod";

import { approvalChallengeSchema, passkeyAssertionSchema } from "./approval.js";
import { MAX_RECEIPTS_PER_CLAIM } from "./claims.js";
import {
  NO_RECEIPT_REASON_MAX_LENGTH,
  NO_RECEIPT_REASON_MIN_LENGTH,
} from "./company-spending.js";
import {
  formatUsdAmount,
  parseKesToCents,
  USDC_UNITS_PER_US_CENT,
} from "./kes-amount.js";
import { kraPinSchema } from "./organization.js";

/**
 * Expendi cards (spec §6.25): virtual cards issued through Lithic's sandbox.
 * Each spends from its company's Card balance, filled by Card loads. Amounts
 * are integer US cents on the wire, as decimal strings.
 */

export const CARD_STATES = ["open", "frozen", "closed"] as const;
export const cardStateSchema = z.enum(CARD_STATES);
export type CardState = z.infer<typeof cardStateSchema>;

export const CARD_PURCHASE_KINDS = ["purchase", "refund"] as const;
export const cardPurchaseKindSchema = z.enum(CARD_PURCHASE_KINDS);
export type CardPurchaseKind = z.infer<typeof cardPurchaseKindSchema>;

export const CARD_PURCHASE_STATUSES = [
  "pending",
  "settled",
  "voided",
  "expired",
  "declined",
] as const;
export const cardPurchaseStatusSchema = z.enum(CARD_PURCHASE_STATUSES);
export type CardPurchaseStatus = z.infer<typeof cardPurchaseStatusSchema>;

/** Below this much available, admins hear the Card balance is low. */
export const CARD_BALANCE_LOW_USD_CENTS = 5_000n;

/** Integer US cents for people to read, e.g. 150050n → "USD 1,500.50". */
export function formatUsdCents(cents: bigint): string {
  const magnitude = (cents < 0n ? -cents : cents) * USDC_UNITS_PER_US_CENT;
  return `${cents < 0n ? "-" : ""}${formatUsdAmount(magnitude)}`;
}

const enterUsdAmount = "Enter an amount in US dollars, e.g. 250 or 250.50.";

/** What people type, in US dollars; parsed to integer cents. */
export const usdCentsAmountSchema = z
  .string({ error: enterUsdAmount })
  .transform((value, ctx) => {
    const cents = parseKesToCents(value);
    if (cents === null || cents <= 0n) {
      ctx.addIssue(enterUsdAmount);
      return z.NEVER;
    }
    return cents;
  });

const required = (message: string, max = 120) =>
  z.string({ error: message }).trim().min(1, message).max(max, message);

const E164_PHONE = /^\+[1-9]\d{7,14}$/;
const enterPhone =
  "Enter a phone number with its country code, e.g. +254712345678.";
const phoneSchema = z
  .string({ error: enterPhone })
  .trim()
  .regex(E164_PHONE, enterPhone);

/** `POST /organizations/:id/cards/program`: "Turn on cards". */
export const turnOnCardsRequestSchema = z.object({
  legalName: required("Enter the company's registered name."),
  kraPin: kraPinSchema,
  addressLine1: required("Enter the company's street address."),
  city: required("Enter the city."),
  postalCode: required("Enter the postal code.", 20),
  phone: phoneSchema,
  contactFirstName: required("Enter the responsible person's first name."),
  contactLastName: required("Enter the responsible person's last name."),
  contactEmail: z.email("Enter the responsible person's email."),
  contactPhone: phoneSchema,
});
export type TurnOnCardsRequest = z.input<typeof turnOnCardsRequestSchema>;
export type TurnOnCardsFields = z.output<typeof turnOnCardsRequestSchema>;

export const CARD_NICKNAME_MAX_LENGTH = 60;

const issueCardActionSchema = z.object({
  type: z.literal("issue_card"),
  membershipId: z.uuid({ error: "Pick who holds the card." }),
  nickname: required(
    "Name the card, e.g. Marketing subscriptions.",
    CARD_NICKNAME_MAX_LENGTH,
  ),
  monthlyLimitUsd: usdCentsAmountSchema,
  defaultCategoryId: z.uuid({ error: "Pick a category." }),
});

const cardId = z.uuid({ error: "That card wasn't found." });

/**
 * What an admin's or cardholder's passkey confirms. The same action goes to
 * both steps; the confirmation is bound to it.
 */
export const cardActionSchema = z.discriminatedUnion("type", [
  issueCardActionSchema,
  z.object({
    type: z.literal("raise_limit"),
    cardId,
    monthlyLimitUsd: usdCentsAmountSchema,
  }),
  z.object({ type: z.literal("unfreeze_card"), cardId }),
  z.object({
    type: z.literal("load_balance"),
    amountUsd: usdCentsAmountSchema,
  }),
  z.object({ type: z.literal("reveal_card"), cardId }),
]);
export type CardActionRequest = z.input<typeof cardActionSchema>;
export type CardAction = z.output<typeof cardActionSchema>;

/** `POST …/cards/confirmations` answers with this. */
export const cardConfirmationSchema = approvalChallengeSchema;
export type CardConfirmation = z.infer<typeof cardConfirmationSchema>;

/** `POST …/cards/confirmations/:challengeId`. */
export const confirmCardActionRequestSchema = z.object({
  action: cardActionSchema,
  response: passkeyAssertionSchema,
});
export type ConfirmCardActionRequest = z.input<
  typeof confirmCardActionRequestSchema
>;

/** `POST …/cards/:cardId/lower-limit`: needs no passkey, so it can only go down. */
export const lowerCardLimitRequestSchema = z.object({
  monthlyLimitUsd: usdCentsAmountSchema,
});
export type LowerCardLimitRequest = z.input<typeof lowerCardLimitRequestSchema>;

/** `GET …/cards`: admins and accountants get every card, others their own. */
export const listCardsQuerySchema = z.object({
  state: cardStateSchema.optional(),
  mine: z
    .enum(["true", "false"], { error: "mine is true or false." })
    .transform((value) => value === "true")
    .optional(),
});
export type ListCardsQuery = z.input<typeof listCardsQuerySchema>;

/** `GET …/cards/purchases`, newest first. */
export const listCardPurchasesQuerySchema = z.object({
  cardId: z.uuid().optional(),
  status: cardPurchaseStatusSchema.optional(),
  needsReceipt: z
    .enum(["true", "false"], { error: "needsReceipt is true or false." })
    .transform((value) => value === "true")
    .optional(),
  mine: z
    .enum(["true", "false"], { error: "mine is true or false." })
    .transform((value) => value === "true")
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListCardPurchasesQuery = z.input<
  typeof listCardPurchasesQuerySchema
>;

/** `POST …/cards/purchases/:purchaseId/receipts`: holder or admin, any time. */
export const attachCardReceiptRequestSchema = z.object({
  receiptFileIds: z
    .array(z.uuid({ error: "That receipt isn't available." }))
    .min(1, "Add a receipt.")
    .max(
      MAX_RECEIPTS_PER_CLAIM,
      `Add at most ${MAX_RECEIPTS_PER_CLAIM} receipts.`,
    ),
  categoryId: z.uuid({ error: "Pick a category." }).optional(),
});
export type AttachCardReceiptRequest = z.input<
  typeof attachCardReceiptRequestSchema
>;

const sayWhyNoReceipt = "Say why there's no receipt, in a few words.";

/** `POST …/cards/purchases/:purchaseId/no-receipt`: admins only. */
export const waiveCardReceiptRequestSchema = z.object({
  reason: z
    .string({ error: sayWhyNoReceipt })
    .trim()
    .min(NO_RECEIPT_REASON_MIN_LENGTH, sayWhyNoReceipt)
    .max(
      NO_RECEIPT_REASON_MAX_LENGTH,
      `Keep the reason to ${NO_RECEIPT_REASON_MAX_LENGTH} characters or fewer.`,
    ),
  categoryId: z.uuid({ error: "Pick a category." }).optional(),
});
export type WaiveCardReceiptRequest = z.input<
  typeof waiveCardReceiptRequestSchema
>;

const cents = z.string().regex(/^\d+$/);
const signedCents = z.string().regex(/^-?\d+$/);

const holderSchema = z.object({
  membershipId: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
});

const categorySchema = z.object({ id: z.uuid(), name: z.string() });

/** Everything is worked out from Card loads and purchases when it's read. */
export const cardBalanceSchema = z.object({
  loadedUsdCents: cents,
  spentUsdCents: cents,
  refundedUsdCents: cents,
  onHoldUsdCents: cents,
  /** loaded + refunded − spent − on hold; a late clearing can take it below 0. */
  availableUsdCents: signedCents,
});
export type CardBalance = z.infer<typeof cardBalanceSchema>;

/** `GET …/cards/program`; `POST` answers with the same "on" shape. */
export const cardProgramSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("off") }),
  z.object({
    status: z.literal("on"),
    legalName: z.string(),
    balance: cardBalanceSchema,
    lowBalance: z.boolean(),
    /** Ops paused payouts, which also stops Card loads and new cards. */
    paused: z.boolean(),
    turnedOnAt: z.iso.datetime(),
  }),
]);
export type CardProgram = z.infer<typeof cardProgramSchema>;

export const expendiCardSchema = z.object({
  id: z.uuid(),
  nickname: z.string(),
  lastFour: z.string(),
  state: cardStateSchema,
  monthlyLimitUsdCents: cents,
  /** This calendar month: settled purchases plus holds, less nothing. */
  spentThisMonthUsdCents: cents,
  holder: holderSchema,
  /** The caller holds it. */
  yours: z.boolean(),
  defaultCategory: categorySchema,
  issuedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type ExpendiCard = z.infer<typeof expendiCardSchema>;

export const cardListSchema = z.object({
  cards: z.array(expendiCardSchema),
});
export type CardList = z.infer<typeof cardListSchema>;

export const cardPurchaseSchema = z.object({
  id: z.uuid(),
  kind: cardPurchaseKindSchema,
  status: cardPurchaseStatusSchema,
  card: z.object({
    id: z.uuid(),
    nickname: z.string(),
    lastFour: z.string(),
  }),
  holder: holderSchema,
  yours: z.boolean(),
  merchant: z.string(),
  mcc: z.string(),
  holdUsdCents: cents,
  settledUsdCents: cents,
  /** Set once the Card expense exists, with the rate it used. */
  amountKes: cents.nullable(),
  usdKesRate: z.string().nullable(),
  authorizedAt: z.iso.datetime(),
  /** Why Lithic or the Card balance check declined it. */
  declineReason: z.string().nullable(),
  expenseId: z.uuid().nullable(),
  category: categorySchema,
  receiptCount: z.number().int().nonnegative(),
  noReceiptReason: z.string().nullable(),
  /** A spend with no receipt yet and no admin waiver. */
  needsReceipt: z.boolean(),
  /** It changed after its Card expense was recorded; the books weren't adjusted. */
  changedAfterExpense: z.boolean(),
});
export type CardPurchase = z.infer<typeof cardPurchaseSchema>;

export const cardPurchaseListSchema = z.object({
  purchases: z.array(cardPurchaseSchema),
  nextCursor: z.string().nullable(),
});
export type CardPurchaseList = z.infer<typeof cardPurchaseListSchema>;

export const cardLoadSchema = z.object({
  id: z.uuid(),
  amountUsdCents: cents,
  amountKes: cents,
  usdKesRate: z.string(),
  /** Always true: the sandbox never moves real USDC. */
  simulated: z.boolean(),
  loadedBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type CardLoad = z.infer<typeof cardLoadSchema>;

export const cardLoadListSchema = z.object({
  loads: z.array(cardLoadSchema),
});
export type CardLoadList = z.infer<typeof cardLoadListSchema>;

/** `POST …/cards/confirmations/:challengeId` answers with what was done. */
export const cardActionResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("issue_card"), card: expendiCardSchema }),
  z.object({ type: z.literal("raise_limit"), card: expendiCardSchema }),
  z.object({ type: z.literal("unfreeze_card"), card: expendiCardSchema }),
  z.object({ type: z.literal("load_balance"), load: cardLoadSchema }),
  z.object({
    type: z.literal("reveal_card"),
    /** Open this page to show the details; the session is in its fragment. */
    revealUrl: z.url(),
    expiresAt: z.iso.datetime(),
  }),
]);
export type CardActionResult = z.infer<typeof cardActionResultSchema>;

export const CARD_NOTIFICATION_TYPES = [
  "card_issued",
  "card_receipt_needed",
  "card_receipt_reminder",
  "card_purchase_declined",
  "card_balance_low",
  "card_refund_received",
] as const;
export type CardNotificationType = (typeof CARD_NOTIFICATION_TYPES)[number];

/** What the app opens from a card push; `card_balance_low` names only the company. */
export const cardNotificationDataSchema = z.object({
  type: z.enum(CARD_NOTIFICATION_TYPES),
  organizationId: z.uuid(),
  cardId: z.uuid().optional(),
  purchaseId: z.uuid().optional(),
});
export type CardNotificationData = z.infer<typeof cardNotificationDataSchema>;
