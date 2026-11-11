import { z } from "zod";

import { payeeChainSchema } from "./payee-chain.js";
import { walletChainSchema, walletTransactionTypeSchema } from "./wallet.js";

export const PAYOUT_SUBJECT_TYPES = [
  "claim",
  "bill",
  "float",
  "withdrawal",
] as const;
export const payoutSubjectTypeSchema = z.enum(PAYOUT_SUBJECT_TYPES);
export type PayoutSubjectType = z.infer<typeof payoutSubjectTypeSchema>;

export const PAYOUT_METHODS = [
  "mpesa_phone",
  "mpesa_till",
  "mpesa_paybill",
  "bank",
  "usdc",
] as const;
export const payoutMethodSchema = z.enum(PAYOUT_METHODS);
export type PayoutMethod = z.infer<typeof payoutMethodSchema>;

/**
 * awaiting_approval → approved → order_created → funding → paying → paid,
 * or failed (nothing left the wallet, or it came back) or needs_review (a
 * person is checking it; it's never re-sent automatically).
 */
export const PAYOUT_STATUSES = [
  "awaiting_approval",
  "approved",
  "order_created",
  "funding",
  "paying",
  "paid",
  "failed",
  "needs_review",
] as const;
export const payoutStatusSchema = z.enum(PAYOUT_STATUSES);
export type PayoutStatus = z.infer<typeof payoutStatusSchema>;

const integerString = z.string().regex(/^-?\d+$/);
const digits = z.string().regex(/^\d+$/);

/** The payout a ledger row belongs to: a payout, its refund, or a withdrawal. */
export const walletHistoryPayoutSchema = z.object({
  id: z.uuid(),
  subjectType: payoutSubjectTypeSchema,
  method: payoutMethodSchema,
  /** The payee's name, or the allowlist label for a withdrawal. */
  recipientName: z.string(),
  /**
   * Where it went, safe to show: an M-Pesa number masked to its last 4
   * digits, a Till or Paybill number, a bank account's last 4, or the
   * address a USDC payout went to.
   */
  recipientDetail: z.string(),
  /** The payee chain of a USDC payout or withdrawal; null for a cash-out. */
  recipientChain: payeeChainSchema.nullable(),
  /** What the recipient receives (KES cents); the KES value for USDC. */
  amountKesCents: digits,
  status: payoutStatusSchema,
  /** The claim, bill, float movement or withdrawal it pays. */
  subjectId: z.uuid(),
  /** Set for a salary or one-off paid in a payroll run (`/payroll?runId=`). */
  payrollRunId: z.uuid().nullable(),
  /** Payouts approved with one passkey confirmation share it. */
  approvalId: z.uuid().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
  /** KES per USDC the payout was sent at; null until Paycrest gives one. */
  rate: z.string().nullable(),
  /** Why it failed, for people to read. */
  failureReason: z.string().nullable(),
});

export type WalletHistoryPayout = z.infer<typeof walletHistoryPayoutSchema>;

export const walletHistoryItemSchema = z.object({
  id: z.uuid(),
  type: walletTransactionTypeSchema,
  /** USDC base units, signed: credits positive, debits negative. */
  usdcAmount: integerString,
  /**
   * The chain the money moved on: NEAR for the company wallet, Base for the
   * transit wallet.
   */
  chain: walletChainSchema,
  /**
   * The transaction on `chain`: a 0x hash on Base, a base58 hash on NEAR.
   * A NEAR hash is case-sensitive, so show and link it exactly as given.
   */
  txHash: z.string().nullable(),
  /** The sender of money in, or where money out went. */
  counterpartyAddress: z.string().nullable(),
  createdAt: z.iso.datetime(),
  payout: walletHistoryPayoutSchema.nullable(),
});

export type WalletHistoryItem = z.infer<typeof walletHistoryItemSchema>;

export const WALLET_HISTORY_PAGE_SIZE = 25;

/**
 * `GET /organizations/:id/wallet/history?before=<nextCursor>`, newest
 * first. `nextCursor` is null on the last page.
 */
export const walletHistoryResponseSchema = z.object({
  items: z.array(walletHistoryItemSchema),
  nextCursor: z.uuid().nullable(),
});

export type WalletHistoryResponse = z.infer<typeof walletHistoryResponseSchema>;
