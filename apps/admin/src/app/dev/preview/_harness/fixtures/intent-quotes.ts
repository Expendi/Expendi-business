import type {
  IntentQuoteEvidence,
  StaffIntentQuoteDetail,
  StaffIntentQuoteSummary,
} from "@expendi-business/shared";

import { COMPANY_ID, companySummary } from "./companies";
import { minutesAgo, sampleId } from "./ids";
import { PAYOUTS } from "./payouts";

export const INTENT_QUOTE_ID = sampleId(701);

interface QuoteInput {
  n: number;
  companyId?: string;
  purpose: StaffIntentQuoteSummary["purpose"];
  status: StaffIntentQuoteSummary["status"];
  oneClickStatus: StaffIntentQuoteSummary["oneClickStatus"];
  amountOut: string;
  failure?: string | null;
  payoutsInReview?: number;
  openSends?: number;
  updatedMinutesAgo: number;
}

function quote(input: QuoteInput): StaffIntentQuoteSummary {
  const company = companySummary(input.companyId ?? COMPANY_ID);
  return {
    id: sampleId(700 + input.n),
    organization: { id: company.id, name: company.name },
    purpose: input.purpose,
    status: input.status,
    oneClickStatus: input.oneClickStatus,
    amountIn: String(BigInt(input.amountOut) + 1_200_000n),
    amountOut: input.amountOut,
    depositAddress:
      "a4c91f07be3d5826c10e9a7f4b2d8e63c5a01f9b7d4e2c8a6b3f1d0e9c7a5b21",
    recipient: "0x7be2c19f4a8d03e5b61c2f97d8a40e3b5c1d9f62",
    deadline: minutesAgo(input.updatedMinutesAgo - 240),
    failure: input.failure ?? null,
    payoutsInReview: input.payoutsInReview ?? 0,
    openSends: input.openSends ?? 0,
    createdAt: minutesAgo(input.updatedMinutesAgo + 50),
    updatedAt: minutesAgo(input.updatedMinutesAgo),
  };
}

const REVIEW_QUOTE: StaffIntentQuoteSummary = {
  ...quote({
    n: 1,
    purpose: "usdc_payout",
    status: "needs_review",
    oneClickStatus: "PROCESSING",
    amountOut: "500000000",
    failure:
      "1Click has been processing for over an hour and the deposit address shows no delivery.",
    payoutsInReview: 1,
    openSends: 1,
    updatedMinutesAgo: 35,
  }),
  id: INTENT_QUOTE_ID,
};

export const INTENT_QUOTES: StaffIntentQuoteSummary[] = [
  REVIEW_QUOTE,
  quote({
    n: 2,
    companyId: sampleId(2),
    purpose: "base_hop",
    status: "failed",
    oneClickStatus: "FAILED",
    amountOut: "1250000000",
    failure: "1Click couldn't route the swap and refunded the deposit.",
    updatedMinutesAgo: 140,
  }),
  quote({
    n: 3,
    companyId: sampleId(3),
    purpose: "sweep",
    status: "succeeded",
    oneClickStatus: "SUCCESS",
    amountOut: "320000000",
    payoutsInReview: 2,
    updatedMinutesAgo: 260,
  }),
  quote({
    n: 4,
    purpose: "fund_in_return",
    status: "refunded",
    oneClickStatus: "REFUNDED",
    amountOut: "75000000",
    openSends: 1,
    updatedMinutesAgo: 520,
  }),
];

const HELD_PAYOUT = PAYOUTS.find((payout) => payout.status === "needs_review");

export const INTENT_QUOTE_DETAIL: StaffIntentQuoteDetail = {
  ...REVIEW_QUOTE,
  originChain: "base",
  destinationChain: "solana",
  swapType: "EXACT_OUTPUT",
  minAmountOut: null,
  refundTo: "0x4f2a9c81d3b7e60a15c8f2d94b73e0a6c1d58e37",
  depositStartedAt: minutesAgo(80),
  depositTxHash:
    "0x31ac7d90e4b25f86a1c03d7e92b48f5a60c1e3d79b2a45f8e0d61c3b97a24f50",
  companyWalletSendId: sampleId(801),
  depositPrivyTransactionId: "tx_cm3x9k7q2",
  depositType: "ORIGIN_CHAIN",
  recipientType: "DESTINATION_CHAIN",
  refundType: "ORIGIN_CHAIN",
  intentHash: null,
  intentDeadline: null,
  intentSubmittedAt: null,
  oneClickCheckedAt: minutesAgo(36),
  nearTxHashes: ["9Kx2mQ4vTb7WcN1eRf8sLz3YdHj6uPa5GoVi0XtB2nCw"],
  originChainTxHashes: [
    "0x31ac7d90e4b25f86a1c03d7e92b48f5a60c1e3d79b2a45f8e0d61c3b97a24f50",
  ],
  destinationChainTxHashes: [],
  depositedAmount: "501200000",
  swappedAmountIn: "501200000",
  swappedAmountOut: null,
  refundedAmount: null,
  refundReason: null,
  settledAt: null,
  payouts: HELD_PAYOUT ? [HELD_PAYOUT] : [],
  auditTrail: [
    {
      id: sampleId(711),
      occurredAt: minutesAgo(35),
      actor: { type: "system", id: "intent-reconciliation", email: null },
      organization: { id: COMPANY_ID, name: "Mwangaza Logistics" },
      action: "intent_quote.needs_review",
      entity: { type: "intent_quote", id: INTENT_QUOTE_ID },
      before: { status: "depositing" },
      after: { status: "needs_review" },
      requestId: null,
      ip: null,
      userAgent: null,
    },
    {
      id: sampleId(712),
      occurredAt: minutesAgo(80),
      actor: {
        type: "user",
        id: sampleId(101),
        email: "wanjiru@mwangaza.co.ke",
      },
      organization: { id: COMPANY_ID, name: "Mwangaza Logistics" },
      action: "intent_quote.deposit_started",
      entity: { type: "intent_quote", id: INTENT_QUOTE_ID },
      before: { status: "quoted" },
      after: { status: "depositing" },
      requestId: "req_a31f90",
      ip: "197.232.14.20",
      userAgent: "Mozilla/5.0",
    },
  ],
};

export const INTENT_QUOTE_EVIDENCE: IntentQuoteEvidence = {
  oneClickStatus: "PROCESSING",
  depositedAmount: "501200000",
  deposits: [
    {
      chain: "base",
      txHash:
        "0x31ac7d90e4b25f86a1c03d7e92b48f5a60c1e3d79b2a45f8e0d61c3b97a24f50",
      from: "0x4f2a9c81d3b7e60a15c8f2d94b73e0a6c1d58e37",
      to: "0xa4c91f07be3d5826c10e9a7f4b2d8e63c5a01f9b",
      usdcAmount: "501200000",
      blockNumber: "21804417",
    },
  ],
  deliveries: [],
  refunds: [],
  unreadDeliveries: [],
  companyWalletSends: [],
  payouts: HELD_PAYOUT
    ? [{ id: HELD_PAYOUT.id, status: HELD_PAYOUT.status, ledger: [] }]
    : [],
};

export function intentQuoteDetail(id: string): StaffIntentQuoteDetail {
  const summary = INTENT_QUOTES.find((candidate) => candidate.id === id);
  if (!summary || summary.id === INTENT_QUOTE_ID) return INTENT_QUOTE_DETAIL;
  return { ...INTENT_QUOTE_DETAIL, ...summary, payouts: [] };
}
