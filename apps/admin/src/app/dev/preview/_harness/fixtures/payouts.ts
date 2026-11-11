import type {
  StaffPayoutDetail,
  StaffPayoutSummary,
} from "@expendi-business/shared";

import { COMPANY_ID, companySummary } from "./companies";
import { minutesAgo, sampleId } from "./ids";

export const PAYOUT_ID = sampleId(201);

interface PayoutInput {
  n: number;
  companyId?: string;
  subjectType?: StaffPayoutSummary["subjectType"];
  method?: StaffPayoutSummary["method"];
  status: StaffPayoutSummary["status"];
  amountKesCents: string;
  amountToTransferUsdc?: string | null;
  provider?: StaffPayoutSummary["provider"];
  reference?: string | null;
  providerStatus?: string | null;
  failureReason?: string | null;
  payrollRunId?: string | null;
  updatedMinutesAgo: number;
}

function payout(input: PayoutInput): StaffPayoutSummary {
  const company = companySummary(input.companyId ?? COMPANY_ID);
  const provider = input.provider ?? "paycrest";
  return {
    id: sampleId(200 + input.n),
    organization: { id: company.id, name: company.name },
    chain: "base",
    subjectType: input.subjectType ?? "bill",
    subjectId: sampleId(300 + input.n),
    payrollRunId: input.payrollRunId ?? null,
    provider,
    method: input.method ?? "mpesa_paybill",
    status: input.status,
    amountKesCents: input.amountKesCents,
    amountToTransferUsdc: input.amountToTransferUsdc ?? null,
    providerOrderId: provider === "paycrest" ? `pc_${1000 + input.n}` : null,
    depositAddress:
      provider === "paycrest"
        ? "0x9be1c07a4d2f58a3e6c1b0794d8a25f3e1c06b72"
        : null,
    txHash:
      input.status === "needs_review" || input.status === "paid"
        ? `0x${String(input.n).padStart(2, "0")}c4a1e9d07b3f528a6e0d41c97b5f3a82d6e10c49b7a35f82e1d06c3b49a7f5e`
        : null,
    providerReference: input.reference ?? null,
    providerStatus: input.providerStatus ?? null,
    providerCheckedAt: minutesAgo(input.updatedMinutesAgo - 2),
    failureReason: input.failureReason ?? null,
    fundingStartedAt: minutesAgo(input.updatedMinutesAgo + 6),
    createdAt: minutesAgo(input.updatedMinutesAgo + 60),
    updatedAt: minutesAgo(input.updatedMinutesAgo),
  };
}

const REVIEW_PAYOUT: StaffPayoutSummary = {
  ...payout({
    n: 1,
    status: "needs_review",
    amountKesCents: "18450000",
    amountToTransferUsdc: "1430233000",
    providerStatus: "pending",
    updatedMinutesAgo: 42,
  }),
  id: PAYOUT_ID,
};

export const PAYOUTS: StaffPayoutSummary[] = [
  REVIEW_PAYOUT,
  payout({
    n: 2,
    companyId: sampleId(2),
    subjectType: "claim",
    method: "mpesa_phone",
    status: "failed",
    amountKesCents: "1275000",
    providerStatus: "refunded",
    failureReason:
      "M-Pesa couldn't reach the phone number. The order was refunded.",
    updatedMinutesAgo: 95,
  }),
  payout({
    n: 3,
    companyId: sampleId(3),
    subjectType: "bill",
    method: "bank",
    status: "needs_review",
    amountKesCents: "9620000",
    providerStatus: "processing",
    updatedMinutesAgo: 190,
  }),
  payout({
    n: 4,
    subjectType: "float",
    method: "mpesa_till",
    status: "failed",
    amountKesCents: "3000000",
    failureReason: "Paycrest rejected the order: the till number isn't active.",
    updatedMinutesAgo: 380,
  }),
  payout({
    n: 5,
    companyId: sampleId(5),
    subjectType: "withdrawal",
    method: "usdc",
    provider: "onchain",
    status: "needs_review",
    amountKesCents: "6450000",
    amountToTransferUsdc: "500000000",
    updatedMinutesAgo: 610,
  }),
  payout({
    n: 6,
    subjectType: "claim",
    method: "mpesa_phone",
    status: "paid",
    amountKesCents: "420000",
    reference: "TKB7H2M9QX",
    providerStatus: "settled",
    payrollRunId: sampleId(401),
    updatedMinutesAgo: 1500,
  }),
];

export const PAYOUT_DETAIL: StaffPayoutDetail = {
  ...REVIEW_PAYOUT,
  recipient: { name: "Rift Valley Fuel Depot", detail: "Paybill 247247" },
  heldByIntentQuoteId: null,
  quotedUsdc: "1430233000",
  maxDebitUsdc: "1444535000",
  rate: "128.9",
  depositValidUntil: minutesAgo(-720),
  privyTransactionId: "tx_cm3x9k0a4",
  gatewayOrderId: "gw_77a10c",
  approvedAt: minutesAgo(118),
  paidAt: null,
  walletAddress: "0x4f2a9c81d3b7e60a15c8f2d94b73e0a6c1d58e37",
  ledger: [
    {
      id: sampleId(501),
      type: "payout",
      usdcAmount: "-1430233000",
      chain: "base",
      txHash: REVIEW_PAYOUT.txHash,
      createdAt: minutesAgo(100),
    },
  ],
  auditTrail: [
    {
      id: sampleId(601),
      occurredAt: minutesAgo(42),
      actor: { type: "system", id: "payout-reconciliation", email: null },
      organization: { id: COMPANY_ID, name: "Mwangaza Logistics" },
      action: "payout.needs_review",
      entity: { type: "payout", id: PAYOUT_ID },
      before: { status: "paying" },
      after: { status: "needs_review" },
      requestId: null,
      ip: null,
      userAgent: null,
    },
    {
      id: sampleId(602),
      occurredAt: minutesAgo(100),
      actor: {
        type: "user",
        id: sampleId(101),
        email: "wanjiru@mwangaza.co.ke",
      },
      organization: { id: COMPANY_ID, name: "Mwangaza Logistics" },
      action: "payout.funded",
      entity: { type: "payout", id: PAYOUT_ID },
      before: { status: "funding" },
      after: { status: "paying" },
      requestId: "req_8f21c4",
      ip: "197.232.14.20",
      userAgent: "Mozilla/5.0",
    },
  ],
};

export function payoutDetail(id: string): StaffPayoutDetail {
  const summary = PAYOUTS.find((payout) => payout.id === id);
  if (!summary || summary.id === PAYOUT_ID) return PAYOUT_DETAIL;
  return {
    ...PAYOUT_DETAIL,
    ...summary,
    recipient: { name: "Sample recipient", detail: "Phone ending 4821" },
  };
}
