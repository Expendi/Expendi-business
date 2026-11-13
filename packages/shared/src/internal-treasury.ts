import { z } from "zod";

import { opsAlertSchema } from "./internal-alerts.js";
import {
  intentQuoteStatusSchema,
  oneClickStatusSchema,
} from "./internal-intent-quotes.js";
import { staffReasonSchema } from "./internal-ops.js";
import {
  treasuryMoveDirectionSchema,
  treasuryMoveStatusSchema,
} from "./treasury-move.js";
import { walletChainSchema } from "./wallet.js";

/**
 * A company's Treasury as the Expendi team sees it (docs/work/treasury/spec.md,
 * "Expendi team"): the wallet, the live position, the open alerts and every
 * move with the saved rows that prove what happened. USDC amounts are
 * base-unit integer strings.
 */

const digits = z.string().regex(/^\d+$/);
const signed = z.string().regex(/^-?\d+$/);

export const staffTreasuryQuoteSchema = z.object({
  id: z.uuid(),
  purpose: z.enum(["to_treasury", "from_treasury"]),
  status: intentQuoteStatusSchema,
  oneClickStatus: oneClickStatusSchema.nullable(),
  amountIn: digits,
  amountOut: digits,
  swappedAmountOut: digits.nullable(),
  refundedAmount: digits.nullable(),
  /** The send that paid the deposit address: base58 on NEAR, 0x on Base. */
  depositTxHash: z.string().nullable(),
  nearTxHashes: z.array(z.string()),
  originChainTxHashes: z.array(z.string()),
  destinationChainTxHashes: z.array(z.string()),
  failure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(),
});

export type StaffTreasuryQuote = z.infer<typeof staffTreasuryQuoteSchema>;

export const staffTreasuryEarnActionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["deposit", "withdraw"]),
  attempt: z.number().int().positive(),
  referenceId: z.string(),
  status: z.enum(["saved", "pending", "succeeded", "rejected", "failed"]),
  rawAmount: digits,
  /** A withdrawal's USDC that reached the Treasury wallet; null until read. */
  deliveredUsdc: digits.nullable(),
  privyActionId: z.string().nullable(),
  txHash: z.string().nullable(),
  intentQuoteId: z.uuid().nullable(),
  failure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(),
});

export type StaffTreasuryEarnAction = z.infer<
  typeof staffTreasuryEarnActionSchema
>;

export const staffTreasuryLedgerRowSchema = z.object({
  id: z.uuid(),
  type: z.enum(["to_treasury", "from_treasury"]),
  /** Negative for `to_treasury`, positive for `from_treasury`. */
  usdcAmount: signed,
  chain: walletChainSchema,
  txHash: z.string().nullable(),
  intentQuoteId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type StaffTreasuryLedgerRow = z.infer<
  typeof staffTreasuryLedgerRowSchema
>;

/**
 * The two things staff may start on a move under review, each behind a
 * second confirmation:
 * - `return_stranded_deposit`: a move to Treasury whose vault deposit Privy
 *   rejected; its undeposited USDC is sent back to the company wallet.
 * - `resume_return`: a move to the wallet whose withdrawal delivered but
 *   whose return didn't finish; exactly what is still owed is sent.
 */
export const STAFF_TREASURY_ACTIONS = [
  "return_stranded_deposit",
  "resume_return",
] as const;
export const staffTreasuryActionSchema = z.enum(STAFF_TREASURY_ACTIONS);
export type StaffTreasuryAction = z.infer<typeof staffTreasuryActionSchema>;

export const staffTreasuryMoveSchema = z.object({
  id: z.uuid(),
  direction: treasuryMoveDirectionSchema,
  status: treasuryMoveStatusSchema,
  isAll: z.boolean(),
  requestedUsdc: digits,
  movedUsdc: digits.nullable(),
  costUsdc: signed.nullable(),
  failure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(),
  quotes: z.array(staffTreasuryQuoteSchema),
  earnActions: z.array(staffTreasuryEarnActionSchema),
  ledger: z.array(staffTreasuryLedgerRowSchema),
  /** What staff may start on this move now, with the USDC it would send; null if nothing. */
  action: z
    .object({
      kind: staffTreasuryActionSchema,
      amountUsdc: digits,
    })
    .nullable(),
});

export type StaffTreasuryMove = z.infer<typeof staffTreasuryMoveSchema>;

export const staffTreasuryPositionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("read"),
    assetsInVault: digits,
    sharesInVault: digits,
    totalDeposited: digits,
    totalWithdrawn: digits,
    readAt: z.iso.datetime(),
  }),
  z.object({ state: z.literal("unreadable"), message: z.string() }),
]);

export type StaffTreasuryPosition = z.infer<typeof staffTreasuryPositionSchema>;

/** `GET /internal/companies/:organizationId/treasury`. */
export const staffTreasurySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("off") }),
  z.object({
    status: z.literal("on"),
    address: z.string(),
    turnedOnAt: z.iso.datetime(),
    position: staffTreasuryPositionSchema,
    /** Open alerts of the `treasury_*` kinds for this company. */
    alerts: z.array(opsAlertSchema),
    /** Newest first. */
    moves: z.array(staffTreasuryMoveSchema),
  }),
]);

export type StaffTreasury = z.infer<typeof staffTreasurySchema>;

/** `POST /internal/companies/:organizationId/treasury/moves/:moveId/:action/prepare`. */
export const staffTreasuryPrepareRequestSchema = z.object({
  reason: staffReasonSchema,
});

export type StaffTreasuryPrepareRequest = z.input<
  typeof staffTreasuryPrepareRequestSchema
>;

export const staffTreasuryPreparedSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  action: staffTreasuryActionSchema,
  reason: z.string(),
  /** The USDC confirming will send back to the company wallet. */
  amountUsdc: digits,
  consequences: z.array(z.string()),
});

export type StaffTreasuryPrepared = z.infer<typeof staffTreasuryPreparedSchema>;

export const staffTreasuryConfirmedSchema = z.object({
  moveId: z.uuid(),
  action: staffTreasuryActionSchema,
  /** The most the job may send back; what it sends is what is still owed then. */
  amountUsdc: digits,
});

export type StaffTreasuryConfirmed = z.infer<
  typeof staffTreasuryConfirmedSchema
>;
