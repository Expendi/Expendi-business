import { z } from "zod";

import { billStatusSchema } from "./bills.js";
import { cardStateSchema, usdCentsAmountSchema } from "./cards.js";
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

const walletBalanceHomeSchema = z.enum([
  "company_wallet",
  "confidential_account",
]);

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

/**
 * The companies a cash-out can go through. The active one, chosen by staff
 * for every company at once, takes each new cash-out; `onchain` pays USDC
 * and is never one of them.
 */
export const CASH_OUT_PROVIDERS = ["paycrest", "pretium"] as const;
export const cashOutProviderSchema = z.enum(CASH_OUT_PROVIDERS);
export type CashOutProvider = z.infer<typeof cashOutProviderSchema>;

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
  provider: z.enum(["paycrest", "pretium", "onchain"]),
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
  /** The provider's last reported status, and when we asked. */
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
      /** Where the company's USDC sits at rest. */
      balanceHome: walletBalanceHomeSchema,
      /**
       * What the alert check last read from the company's confidential
       * account, USDC base units, and when. Staff can't read it themselves;
       * null until the check has.
       */
      confidentialUsdc: integerString.nullable(),
      confidentialUsdcReadAt: z.iso.datetime().nullable(),
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
  /**
   * A Pretium cash-out whose shillings weren't paid: when Pretium was asked
   * for the USDC back, and the Base hash it gave for the refund. Always
   * null for Paycrest, which refunds by itself.
   */
  refundRequestedAt: z.iso.datetime().nullable(),
  refundTxHash: z.string().nullable(),
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
  /** The status the payout's cash-out provider reported just now. */
  providerStatus: z.string(),
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

/**
 * What Pretium said of a cash-out just now. A failed read is `unreadable`,
 * never `not_found`: only a successful search that found nothing says
 * Pretium has no transaction for the transfer.
 */
export const pretiumTransactionEvidenceSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("found"),
    /** By the payout's transaction code, or by the transfer's hash. */
    lookedUpBy: z.enum(["code", "hash"]),
    transactionCode: z.string(),
    /** As Pretium sends it: PENDING, PROCESSING, COMPLETE, FAILED, … */
    status: z.string(),
    /** The Base transfer Pretium paid against, lowercased. */
    transactionHash: z.string().nullable(),
    /** The M-Pesa or bank receipt, once paid. */
    receiptNumber: z.string().nullable(),
    message: z.string().nullable(),
    /** Whether it is for this payout's transfer, by hash or else by code. */
    isThisPayouts: z.boolean(),
  }),
  z.object({ state: z.literal("not_found"), lookedUpBy: z.literal("hash") }),
  z.object({
    state: z.literal("unreadable"),
    lookedUpBy: z.enum(["code", "hash"]),
    message: z.string(),
  }),
  /** No transaction code and no transfer to look one up by. */
  z.object({ state: z.literal("not_asked") }),
]);

export type PretiumTransactionEvidence = z.infer<
  typeof pretiumTransactionEvidenceSchema
>;

export const pretiumEvidenceSchema = z.object({
  /** Pretium's Base settlement address as pinned in the API, lowercased. */
  settlementAddress: z.string(),
  /** Whether the payout's deposit address is that pinned address. */
  depositAddressIsSettlement: z.boolean(),
  /**
   * The Base transfer Pretium is matched by: the payout's saved hash, or
   * else the one transfer found on chain. Null when neither exists.
   */
  transferHash: z.string().nullable(),
  transaction: pretiumTransactionEvidenceSchema,
  refundRequestedAt: z.iso.datetime().nullable(),
  refundTxHash: z.string().nullable(),
  /** The refunds credited to the ledger for this payout; null when none. */
  refundCreditedUsdc: digits.nullable(),
});

export type PretiumEvidence = z.infer<typeof pretiumEvidenceSchema>;

/** What the API checked before allowing an outcome. */
export const payoutEvidenceSchema = z.object({
  /** Paycrest's status, fetched just now; null unless a Paycrest order. */
  paycrestStatus: z.string().nullable(),
  /** What Pretium and the ledger say of a Pretium cash-out; else null. */
  pretium: pretiumEvidenceSchema.nullable(),
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

// Cash-out provider

/** One cash-out provider, and whether cash-outs could go through it now. */
export const cashOutProviderReadinessSchema = z.object({
  provider: cashOutProviderSchema,
  active: z.boolean(),
  ready: z.boolean(),
  /** Plain sentences, one per problem; empty when ready. */
  problems: z.array(z.string()),
});

export type CashOutProviderReadiness = z.infer<
  typeof cashOutProviderReadinessSchema
>;

/** `GET /internal/controls/cash-out-provider`: readiness is checked live. */
export const cashOutProviderControlSchema = z.object({
  activeProvider: cashOutProviderSchema,
  /** When staff last changed it; null while it has never been changed. */
  changedAt: z.iso.datetime().nullable(),
  providers: z.array(cashOutProviderReadinessSchema),
});

export type CashOutProviderControl = z.infer<
  typeof cashOutProviderControlSchema
>;

/** `POST /internal/controls/cash-out-provider/prepare`. */
export const cashOutProviderPrepareRequestSchema = z.object({
  provider: z.enum(CASH_OUT_PROVIDERS, {
    error: "Choose Paycrest or Pretium.",
  }),
  reason: staffReasonSchema,
});

export type CashOutProviderPrepareRequest = z.input<
  typeof cashOutProviderPrepareRequestSchema
>;

export const cashOutProviderPreparedSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
  /** The provider confirming will make active. */
  provider: cashOutProviderSchema,
  currentProvider: cashOutProviderSchema,
  reason: z.string(),
  /** Cash-outs waiting for approval, at every company: they follow the change. */
  waitingForApproval: z.number().int().nonnegative(),
  /** Cash-outs approved or in flight, by the provider they finish with. */
  inFlight: z.object({
    paycrest: z.number().int().nonnegative(),
    pretium: z.number().int().nonnegative(),
  }),
  consequences: z.array(z.string()),
});

export type CashOutProviderPrepared = z.infer<
  typeof cashOutProviderPreparedSchema
>;

/** `POST /internal/controls/cash-out-provider/confirm`. */
export const cashOutProviderConfirmedSchema = z.object({
  activeProvider: cashOutProviderSchema,
  previousProvider: cashOutProviderSchema,
});

export type CashOutProviderConfirmed = z.infer<
  typeof cashOutProviderConfirmedSchema
>;

// Sandbox card purchases

/**
 * Staff run the sandbox Card purchase for one recurring payment paid by a
 * company-held card now, as the daily job does on its bill's due date (spec
 * §6.25). Left out, the amount is the payment's estimate and the merchant
 * its usual pretend one; `newMerchant` charges from one the card hasn't
 * seen. A sandbox stand-in until real merchants charge real cards.
 */
export const runCardSimulationRequestSchema = z.object({
  recurringItemId: z.uuid({ error: "Choose a recurring payment." }),
  amountUsd: usdCentsAmountSchema.optional(),
  newMerchant: z.boolean().optional(),
});

export type RunCardSimulationRequest = z.input<
  typeof runCardSimulationRequestSchema
>;

/**
 * `unknown`: Lithic made the purchase but didn't say whether the purchase
 * check approved it, or never confirmed making it at all.
 */
export const CARD_SIMULATION_RESULTS = [
  "approved",
  "declined",
  "unknown",
] as const;

export const cardSimulationResultSchema = z.object({
  /** Lithic's token for the Card purchase it made. */
  transactionToken: z.string(),
  result: z.enum(CARD_SIMULATION_RESULTS),
  /** The pretend merchant's name, as the purchase shows it. */
  merchant: z.string(),
});

export type CardSimulationResult = z.infer<typeof cardSimulationResultSchema>;

/** A recurring payment paid by a company-held card, as staff see it. */
export const staffCardPaidPaymentSchema = z.object({
  id: z.uuid(),
  payeeName: z.string(),
  /** A paused one's purchases are declined, which is worth simulating too. */
  state: z.enum(["active", "paused"]),
  /** US cents per bill; null when it has no estimate. */
  estimateUsdCents: digits.nullable(),
  card: z.object({
    nickname: z.string(),
    lastFour: z.string(),
    state: cardStateSchema,
  }),
  nextBill: z
    .object({
      id: z.uuid(),
      dueOn: z.iso.date(),
      status: billStatusSchema,
      amountUsdCents: digits.nullable(),
    })
    .nullable(),
  lastSimulation: z
    .object({
      at: z.iso.datetime(),
      amountUsdCents: digits,
      merchantKey: z.string(),
      /**
       * Null until the purchase check has seen the purchase; `unknown` when
       * Lithic never confirmed making it.
       */
      result: z.enum(CARD_SIMULATION_RESULTS).nullable(),
      byStaff: z.boolean(),
    })
    .nullable(),
});

export type StaffCardPaidPayment = z.infer<typeof staffCardPaidPaymentSchema>;

/** `GET /internal/companies/:id/card-simulations`. */
export const staffCardSimulationsSchema = z.object({
  /**
   * False when simulated purchases are turned off on the API
   * (`CARD_SIMULATIONS_ENABLED`) or it has no Lithic key.
   */
  available: z.boolean(),
  payments: z.array(staffCardPaidPaymentSchema),
});

export type StaffCardSimulations = z.infer<typeof staffCardSimulationsSchema>;
