import { z } from "zod";

import { auditEntrySchema } from "./internal-audit.js";
import {
  ledgerEntrySchema,
  staffPayoutSummarySchema,
  staffReasonSchema,
} from "./internal-ops.js";
import { payeeChainSchema } from "./payee-chain.js";
import { payoutStatusSchema } from "./wallet-history.js";
import { walletChainSchema } from "./wallet.js";

/**
 * NEAR Intents quotes under review in the internal admin app (spec §6.15,
 * docs/decisions/near-main-chain.md). A quote moves a company's USDC
 * between its own wallets, or out to a USDC payee; when what became of it
 * is unclear, a person resolves it against 1Click and the chains. Staff
 * never send or re-send anything.
 */

const digits = z.string().regex(/^\d+$/);

const blankIsAbsent = (value: unknown) => (value === "" ? undefined : value);

/**
 * Why Expendi took the quote: `base_hop` (company wallet to transit wallet,
 * for a cash-out), `sweep` (transit wallet back to the company wallet),
 * `fund_in` (a company adding money), `usdc_payout` (company wallet to a
 * USDC payee on Base or Solana) and `fund_in_return` (a refunded fund-in,
 * from the company's NEAR Intents account back to its company wallet) and
 * `invoice_payment` (a customer paying an invoice), `to_treasury` (company
 * wallet to the Treasury wallet on Base) and `from_treasury` (the Treasury
 * wallet back to the company wallet).
 */
export const INTENT_QUOTE_PURPOSES = [
  "base_hop",
  "sweep",
  "fund_in",
  "usdc_payout",
  "fund_in_return",
  "invoice_payment",
  "to_treasury",
  "from_treasury",
] as const;
export const intentQuotePurposeSchema = z.enum(INTENT_QUOTE_PURPOSES);
export type IntentQuotePurpose = z.infer<typeof intentQuotePurposeSchema>;

export const INTENT_QUOTE_STATUSES = [
  "quoted",
  "depositing",
  "succeeded",
  "refunded",
  "failed",
  "expired",
  "needs_review",
] as const;
export const intentQuoteStatusSchema = z.enum(INTENT_QUOTE_STATUSES);
export type IntentQuoteStatus = z.infer<typeof intentQuoteStatusSchema>;

/** What 1Click's status endpoint reports for a deposit address. */
export const ONE_CLICK_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export const oneClickStatusSchema = z.enum(ONE_CLICK_STATUSES);
export type OneClickStatus = z.infer<typeof oneClickStatusSchema>;

/** `GET /internal/intent-quotes`: every company unless one is given. */
export const intentQuoteQueueQuerySchema = z.object({
  companyId: z.preprocess(
    blankIsAbsent,
    z.uuid("The company ID isn't valid.").optional(),
  ),
  cursor: z.preprocess(blankIsAbsent, z.string().max(400).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface IntentQuoteQueueQuery {
  companyId?: string;
  cursor?: string;
  limit?: number;
}

/** A quote as staff see it in the review list. */
export const staffIntentQuoteSummarySchema = z.object({
  id: z.uuid(),
  organization: z.object({ id: z.uuid(), name: z.string() }),
  purpose: intentQuotePurposeSchema,
  /**
   * `needs_review`, or `succeeded` or `refunded` when 1Click settled the
   * quote but a payout or a company wallet send it holds wasn't resolved.
   */
  status: intentQuoteStatusSchema,
  /** 1Click's last reported status; null before it was first asked. */
  oneClickStatus: oneClickStatusSchema.nullable(),
  /** USDC base units sent to the deposit address. */
  amountIn: digits,
  /** USDC base units the recipient is quoted to receive. */
  amountOut: digits,
  depositAddress: z.string(),
  recipient: z.string(),
  /** After this, 1Click refunds a deposit instead of delivering it. */
  deadline: z.iso.datetime(),
  failure: z.string().nullable(),
  /** Payouts the quote holds under review. */
  payoutsInReview: z.number().int().nonnegative(),
  /** Company wallet sends paying the quote that nobody closed. */
  openSends: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type StaffIntentQuoteSummary = z.infer<
  typeof staffIntentQuoteSummarySchema
>;

export const intentQuoteQueueResponseSchema = z.object({
  quotes: z.array(staffIntentQuoteSummarySchema),
  nextCursor: z.string().nullable(),
});

export type IntentQuoteQueueResponse = z.infer<
  typeof intentQuoteQueueResponseSchema
>;

/** `GET /internal/intent-quotes/:id`: the saved quote, as last recorded. */
export const staffIntentQuoteDetailSchema =
  staffIntentQuoteSummarySchema.extend({
    /** Where the USDC leaves from, and where it is delivered. */
    originChain: walletChainSchema,
    destinationChain: payeeChainSchema,
    swapType: z.enum(["EXACT_INPUT", "EXACT_OUTPUT"]),
    /** The least the recipient may receive, for `EXACT_INPUT`. */
    minAmountOut: digits.nullable(),
    /** Where 1Click returns the deposit, on the origin chain. */
    refundTo: z.string(),
    depositStartedAt: z.iso.datetime().nullable(),
    /** The deposit's transaction, once known. A NEAR hash is case-sensitive. */
    depositTxHash: z.string().nullable(),
    companyWalletSendId: z.uuid().nullable(),
    depositPrivyTransactionId: z.string().nullable(),
    oneClickCheckedAt: z.iso.datetime().nullable(),
    /** Every transaction 1Click has listed for the quote, as it gave them. */
    nearTxHashes: z.array(z.string()),
    originChainTxHashes: z.array(z.string()),
    destinationChainTxHashes: z.array(z.string()),
    depositedAmount: digits.nullable(),
    swappedAmountIn: digits.nullable(),
    swappedAmountOut: digits.nullable(),
    refundedAmount: digits.nullable(),
    refundReason: z.string().nullable(),
    settledAt: z.iso.datetime().nullable(),
    /** The payouts this quote moves money for, in any status. */
    payouts: z.array(staffPayoutSummarySchema),
    /** The quote's audit entries, newest first. */
    auditTrail: z.array(auditEntrySchema),
  });

export type StaffIntentQuoteDetail = z.infer<
  typeof staffIntentQuoteDetailSchema
>;

const quoteTransferSchema = z.object({
  chain: walletChainSchema,
  /** A NEAR hash is case-sensitive. */
  txHash: z.string(),
  from: z.string(),
  to: z.string(),
  usdcAmount: digits,
  blockNumber: digits,
});

export type QuoteTransfer = z.infer<typeof quoteTransferSchema>;

/** A company wallet send and what the chain shows of each relayer transaction. */
export const companyWalletSendEvidenceSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    "reserved",
    "signed",
    "executed",
    "failed",
    "expired",
    "refused",
  ]),
  senderAccountId: z.string(),
  receiverAccountId: z.string(),
  usdcAmount: digits,
  /** The last block the chain would run it in. */
  maxBlockHeight: digits,
  txHash: z.string().nullable(),
  failure: z.string().nullable(),
  createdAt: z.iso.datetime(),
  transactions: z.array(
    z.object({
      txHash: z.string(),
      final: z.boolean(),
      sendRan: z.boolean().nullable(),
      usdcTransfers: z.array(
        z.object({ from: z.string(), to: z.string(), usdcAmount: digits }),
      ),
    }),
  ),
});

/** What the API read from 1Click and the chains for a quote. */
export const intentQuoteEvidenceSchema = z.object({
  /** 1Click's status, asked just now. */
  oneClickStatus: oneClickStatusSchema.nullable(),
  /** What 1Click says reached the deposit address. */
  depositedAmount: digits.nullable(),
  /** The paying wallet's transfers to the deposit address, on the origin chain. */
  deposits: z.array(quoteTransferSchema),
  /**
   * Transfers to the recipient on the destination chain, in a transaction
   * 1Click lists for the quote.
   */
  deliveries: z.array(quoteTransferSchema),
  /**
   * Transfers back to the refund address on the origin chain, in a
   * transaction 1Click lists. An `EXACT_OUTPUT` quote also returns its
   * unused buffer this way when it delivers.
   */
  refunds: z.array(quoteTransferSchema),
  /**
   * Destination transactions 1Click lists on a chain the API can't read
   * (Solana): its word is the only evidence of those.
   */
  unreadDeliveries: z.array(z.string()),
  /** The company wallet sends that pay the quote, newest first. */
  companyWalletSends: z.array(companyWalletSendEvidenceSchema),
  /** The quote's payouts, with their ledger rows. */
  payouts: z.array(
    z.object({
      id: z.uuid(),
      status: payoutStatusSchema,
      ledger: z.array(ledgerEntrySchema),
    }),
  ),
});

export type IntentQuoteEvidence = z.infer<typeof intentQuoteEvidenceSchema>;

/**
 * What became of the quote's USDC, as staff resolve it: `delivered` to the
 * recipient, `refunded` to the paying wallet, or `never_deposited`: it
 * never left the paying wallet.
 */
export const INTENT_QUOTE_RESOLUTIONS = [
  "delivered",
  "refunded",
  "never_deposited",
] as const;
export const intentQuoteResolutionSchema = z.enum(INTENT_QUOTE_RESOLUTIONS, {
  error: "Choose delivered, refunded or never deposited.",
});
export type IntentQuoteResolution = z.infer<typeof intentQuoteResolutionSchema>;

/** `POST /internal/intent-quotes/:id/resolve/prepare`. */
export const intentQuoteResolvePrepareRequestSchema = z.object({
  outcome: intentQuoteResolutionSchema,
  reason: staffReasonSchema,
});

export type IntentQuoteResolvePrepareRequest = z.input<
  typeof intentQuoteResolvePrepareRequestSchema
>;

export const intentQuoteResolvePreparedSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  outcome: intentQuoteResolutionSchema,
  reason: z.string(),
  /** The quote's status after 1Click was asked again. */
  status: intentQuoteStatusSchema,
  evidence: intentQuoteEvidenceSchema,
  /** What confirming will do, in words, for the review step. */
  consequences: z.array(z.string()),
});

export type IntentQuoteResolvePrepared = z.infer<
  typeof intentQuoteResolvePreparedSchema
>;

/** `POST /internal/intent-quotes/:id/resolve/confirm`. */
export const intentQuoteResolveConfirmedSchema = z.object({
  status: intentQuoteStatusSchema,
  /** The quote's payouts as they now stand. */
  payouts: z.array(z.object({ id: z.uuid(), status: payoutStatusSchema })),
  evidence: intentQuoteEvidenceSchema,
});

export type IntentQuoteResolveConfirmed = z.infer<
  typeof intentQuoteResolveConfirmedSchema
>;
