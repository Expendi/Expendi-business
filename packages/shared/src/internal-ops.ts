import { z } from "zod";

import { auditEntrySchema } from "./internal-audit.js";
import { membershipRoleSchema, membershipStatusSchema } from "./membership.js";
import {
  payoutMethodSchema,
  payoutStatusSchema,
  payoutSubjectTypeSchema,
} from "./wallet-history.js";
import {
  walletChainSchema,
  walletStatusSchema,
  walletTransactionTypeSchema,
} from "./wallet.js";

/**
 * The internal admin app's companies, payout queue and payout pause (spec
 * §6.15, §7.6, T24). Staff look, pause, re-fetch and resolve; they never
 * create, approve, fund or retry a payout or withdrawal.
 */

const digits = z.string().regex(/^\d+$/);
const integerString = z.string().regex(/^-?\d+$/);

const blankIsAbsent = (value: unknown) => (value === "" ? undefined : value);

const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const INTERNAL_PAGE_SIZE = 50;

// Companies

/** `GET /internal/companies`: by name (any part) or exact KRA PIN. */
export const companySearchQuerySchema = z.object({
  search: z.preprocess(blankIsAbsent, z.string().trim().max(120).optional()),
  pausedOnly: z.preprocess(blankIsAbsent, z.enum(["true", "false"]).optional()),
  cursor: z.preprocess(blankIsAbsent, z.string().max(400).optional()),
  limit: pageLimit,
});

export interface CompanySearchQuery {
  search?: string;
  pausedOnly?: "true" | "false";
  cursor?: string;
  limit?: number;
}

export const companySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kraPin: z.string().nullable(),
  payoutsPaused: z.boolean(),
  createdAt: z.iso.datetime(),
});

export type CompanySummary = z.infer<typeof companySummarySchema>;

export const companySearchResponseSchema = z.object({
  companies: z.array(companySummarySchema),
  nextCursor: z.string().nullable(),
});

export type CompanySearchResponse = z.infer<typeof companySearchResponseSchema>;

/** A payout as staff see it in lists. */
export const staffPayoutSummarySchema = z.object({
  id: z.uuid(),
  organization: z.object({ id: z.uuid(), name: z.string() }),
  /**
   * The chain the payout's money leaves from, which `txHash` is on: NEAR
   * for a USDC payout from a company wallet on NEAR, Base for a cash-out
   * (funded from the transit wallet) and for every payout of a company
   * wallet made before the move.
   */
  chain: walletChainSchema,
  subjectType: payoutSubjectTypeSchema,
  subjectId: z.uuid(),
  /** Set when the payout is one person's pay in a payroll run. */
  payrollRunId: z.uuid().nullable(),
  provider: z.enum(["paycrest", "onchain"]),
  method: payoutMethodSchema,
  status: payoutStatusSchema,
  /** What the recipient receives, KES cents. */
  amountKesCents: digits,
  /** Exactly what is (or was to be) sent from the wallet, USDC base units. */
  amountToTransferUsdc: digits.nullable(),
  providerOrderId: z.string().nullable(),
  depositAddress: z.string().nullable(),
  /**
   * The transaction that sent the money: a 0x hash on Base, a base58 hash
   * on NEAR. A NEAR hash is case-sensitive.
   */
  txHash: z.string().nullable(),
  /** The M-Pesa or bank receipt, or the tx hash for a USDC payout. */
  providerReference: z.string().nullable(),
  /** Paycrest's last reported order status, and when we asked. */
  providerStatus: z.string().nullable(),
  providerCheckedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  fundingStartedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type StaffPayoutSummary = z.infer<typeof staffPayoutSummarySchema>;

/** `GET /internal/companies/:id`. */
export const companyDetailSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kraPin: z.string().nullable(),
  createdAt: z.iso.datetime(),
  payoutsPaused: z.boolean(),
  /** Whether every company's payouts are paused too. */
  platformPayoutsPaused: z.boolean(),
  dailyPayoutCapKesCents: digits,
  members: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().nullable(),
      email: z.string(),
      role: membershipRoleSchema,
      status: membershipStatusSchema,
    }),
  ),
  /** Null before sign-up's wallet step has run. */
  wallet: z
    .object({
      /** The chain the company wallet, and `address`, is on. */
      chain: walletChainSchema,
      status: walletStatusSchema,
      address: z.string().nullable(),
      /** The ledger balance, USDC base units. */
      usdcBalance: integerString,
      /** At Paycrest's current rate; null while Paycrest is unavailable. */
      kesEquivalent: z
        .object({ kesCents: digits, rate: z.string() })
        .nullable(),
    })
    .nullable(),
  /** Claims submitted or approved but not yet paid. */
  unpaidClaims: z.object({
    count: z.number().int().nonnegative(),
    totalKesCents: digits,
  }),
  recentPayouts: z.array(staffPayoutSummarySchema),
});

export type CompanyDetail = z.infer<typeof companyDetailSchema>;

// Payout queue

export const STAFF_PAYOUT_QUEUE_STATUSES = ["needs_review", "failed"] as const;
export const staffPayoutQueueStatusSchema = z.enum(STAFF_PAYOUT_QUEUE_STATUSES);
export type StaffPayoutQueueStatus = z.infer<
  typeof staffPayoutQueueStatusSchema
>;

/** `GET /internal/payouts`: both statuses unless one is given. */
export const payoutQueueQuerySchema = z.object({
  status: z.preprocess(blankIsAbsent, staffPayoutQueueStatusSchema.optional()),
  companyId: z.preprocess(
    blankIsAbsent,
    z.uuid("The company ID isn't valid.").optional(),
  ),
  cursor: z.preprocess(blankIsAbsent, z.string().max(400).optional()),
  limit: pageLimit,
});

export interface PayoutQueueQuery {
  status?: StaffPayoutQueueStatus;
  companyId?: string;
  cursor?: string;
  limit?: number;
}

export const payoutQueueResponseSchema = z.object({
  payouts: z.array(staffPayoutSummarySchema),
  nextCursor: z.string().nullable(),
});

export type PayoutQueueResponse = z.infer<typeof payoutQueueResponseSchema>;

export const ledgerEntrySchema = z.object({
  id: z.uuid(),
  type: walletTransactionTypeSchema,
  /** Signed USDC base units. */
  usdcAmount: integerString,
  /** The chain the money moved on; says how to read `txHash`. */
  chain: walletChainSchema,
  txHash: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** `GET /internal/payouts/:id`. */
export const staffPayoutDetailSchema = staffPayoutSummarySchema.extend({
  recipient: z.object({
    name: z.string(),
    /** Masked as in the company's wallet history. */
    detail: z.string(),
  }),
  quotedUsdc: digits,
  maxDebitUsdc: digits,
  rate: z.string().nullable(),
  depositValidUntil: z.iso.datetime().nullable(),
  privyTransactionId: z.string().nullable(),
  gatewayOrderId: z.string().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
  walletAddress: z.string().nullable(),
  /**
   * The NEAR Intents quote the payout waits on (its Base hop, or its
   * delivery to another chain). While it does, staff resolve the quote,
   * not the payout.
   */
  heldByIntentQuoteId: z.uuid().nullable(),
  /** The payout's ledger rows: its debit and any refund. */
  ledger: z.array(ledgerEntrySchema),
  /** The payout's audit entries, newest first. */
  auditTrail: z.array(auditEntrySchema),
});

export type StaffPayoutDetail = z.infer<typeof staffPayoutDetailSchema>;

/** `POST /internal/payouts/:id/refetch`. */
export const payoutRefetchResponseSchema = z.object({
  previousStatus: payoutStatusSchema,
  status: payoutStatusSchema,
  paycrestStatus: z.string(),
});

export type PayoutRefetchResponse = z.infer<typeof payoutRefetchResponseSchema>;

// Second confirmations

export const STAFF_REASON_MIN_LENGTH = 10;
export const STAFF_REASON_MAX_LENGTH = 500;

export const staffReasonSchema = z
  .string({ error: "Write why." })
  .trim()
  .min(
    STAFF_REASON_MIN_LENGTH,
    `Write why, in at least ${STAFF_REASON_MIN_LENGTH} characters.`,
  )
  .max(
    STAFF_REASON_MAX_LENGTH,
    `Keep the reason to ${STAFF_REASON_MAX_LENGTH} characters or fewer.`,
  );

/** The second step of a two-step action: the token the first step returned. */
export const staffConfirmRequestSchema = z.object({
  token: z.string({ error: "The confirmation is missing." }).min(1).max(200),
});

export type StaffConfirmRequest = z.infer<typeof staffConfirmRequestSchema>;

// Resolve

export const RESOLVE_OUTCOMES = ["paid", "failed"] as const;
export const resolveOutcomeSchema = z.enum(RESOLVE_OUTCOMES, {
  error: "Choose paid or failed.",
});
export type ResolveOutcome = z.infer<typeof resolveOutcomeSchema>;

/** `POST /internal/payouts/:id/resolve/prepare`. */
export const resolvePrepareRequestSchema = z.object({
  outcome: resolveOutcomeSchema,
  reason: staffReasonSchema,
});

export type ResolvePrepareRequest = z.input<typeof resolvePrepareRequestSchema>;

const transferSchema = z.object({
  /** The chain the transfer is on; says how to read `txHash`. */
  chain: walletChainSchema,
  txHash: z.string(),
  /** Where the transfer sits in its transaction. */
  logIndex: z.number().int(),
  blockNumber: digits,
  usdcAmount: digits,
});

/** What the API checked before allowing an outcome. */
export const payoutEvidenceSchema = z.object({
  /** Paycrest's status, fetched just now; null for a USDC payout. */
  paycrestStatus: z.string().nullable(),
  /** Every USDC transfer from the company wallet to the deposit address. */
  depositTransfers: z.array(transferSchema),
  /** False when funding never started, so nothing can have been sent. */
  fundingStarted: z.boolean(),
  ledgerDebits: z.array(ledgerEntrySchema),
  refunds: z.array(ledgerEntrySchema),
});

export type PayoutEvidence = z.infer<typeof payoutEvidenceSchema>;

export const resolvePreparedSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  outcome: resolveOutcomeSchema,
  reason: z.string(),
  evidence: payoutEvidenceSchema,
  /** What confirming will do, in words, for the review step. */
  consequences: z.array(z.string()),
});

export type ResolvePrepared = z.infer<typeof resolvePreparedSchema>;

/** `POST /internal/payouts/:id/resolve/confirm`. */
export const resolveConfirmedSchema = z.object({
  status: payoutStatusSchema,
  /** The debit recorded now, when the ledger didn't have it yet. */
  ledgerDebit: ledgerEntrySchema.nullable(),
  evidence: payoutEvidenceSchema,
});

export type ResolveConfirmed = z.infer<typeof resolveConfirmedSchema>;

// Pause

export const PAUSE_SCOPES = ["platform", "company"] as const;

/**
 * `POST /internal/controls/pause/prepare` and `…/unpause/prepare`: every
 * company's payouts, or one company's.
 */
export const pausePrepareRequestSchema = z
  .object({
    scope: z.enum(PAUSE_SCOPES, { error: "Choose all companies or one." }),
    organizationId: z.uuid("Choose a company.").optional(),
    reason: staffReasonSchema,
  })
  .refine(
    (request) => (request.scope === "company") === !!request.organizationId,
    {
      message: "Choose a company to pause, or pause all companies.",
    },
  );

export type PausePrepareRequest = z.input<typeof pausePrepareRequestSchema>;

export const pausePreparedSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  action: z.enum(["pause", "unpause"]),
  scope: z.enum(PAUSE_SCOPES),
  organization: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** Whether payouts in this scope are paused right now. */
  currentlyPaused: z.boolean(),
  reason: z.string(),
  consequences: z.array(z.string()),
});

export type PausePrepared = z.infer<typeof pausePreparedSchema>;

export const pauseConfirmedSchema = z.object({
  scope: z.enum(PAUSE_SCOPES),
  organizationId: z.uuid().nullable(),
  payoutsPaused: z.boolean(),
});

export type PauseConfirmed = z.infer<typeof pauseConfirmedSchema>;

/** `GET /internal/controls`. */
export const controlsResponseSchema = z.object({
  platformPayoutsPaused: z.boolean(),
  platformUpdatedAt: z.iso.datetime(),
  pausedCompanies: z.array(companySummarySchema),
});

export type ControlsResponse = z.infer<typeof controlsResponseSchema>;
