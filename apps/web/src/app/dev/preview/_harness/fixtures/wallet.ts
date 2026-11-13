import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type {
  FundIn,
  PaidFromAccount,
  WalletHistoryItem,
  WalletHistoryPayout,
  WalletHistoryResponse,
  WalletResponse,
  WithdrawalAddress,
} from "@expendi-business/shared";

import { walletKeys } from "~/app/(company)/wallet/_components/wallet-api";
import { billKeys } from "~/features/payment-keys";
import { KES_RATE, ORGANIZATION_ID, sampleId } from "./company";

/** The sample data of docs/mocks/wallet.html, today 6 Nov 2026 in Nairobi. */

const COMPANY_WALLET =
  "8f3a5b2c9d1e4f7a6b0c3d2e1f9a8b7c6d5e4c218f3a5b2c9d1e4f7a6b0c3d2e";
const SENDER = "mwangaza-treasury.near";
/** Where money came from before the company wallet moved to NEAR. */
const BASE_SENDER = "0x71c9a2b4d6e8f0a1b3c5d7e9f2a4b6c8d0e28b2e";

export const ACCOUNTS_WALLET: WalletResponse = {
  status: "active",
  address: COMPANY_WALLET,
  chain: "near",
  usdcBalance: "16420800000",
  kesEquivalent: { kesCents: "211828320", rate: KES_RATE },
  cashOutLimits: { minKesCents: "2000", maxKesCents: "25000000" },
};

export const ALLOWED_ADDRESSES: WithdrawalAddress[] = [
  {
    id: sampleId(601),
    label: "Reserve on Coinbase",
    chain: "base",
    address: "0x12ab7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99f3c",
    confirmedAt: "2026-08-12T07:30:00.000Z",
  },
  {
    id: sampleId(602),
    label: "Ledger cold storage",
    chain: "near",
    address: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f",
    confirmedAt: "2026-09-03T11:05:00.000Z",
  },
];

/** One waiting for its USDC and one delivered, newest first. */
export const FUND_INS: FundIn[] = [
  {
    id: sampleId(621),
    chain: "base",
    amountIn: "2500000000",
    amountOut: "2499870000",
    depositAddress: "0x9d4c1e7a2b5f8036c1d4e7a9b2c5f8e1d4a7b0c3",
    deadline: "2026-11-06T08:30:00.000Z",
    status: "awaiting_deposit",
    createdAt: "2026-11-06T06:30:00.000Z",
  },
  {
    id: sampleId(622),
    chain: "solana",
    amountIn: "6000000000",
    amountOut: "5999910000",
    depositAddress: "4Nd1mYw4r7Vq3Z8kq2cXJ5hT9sQeLb6uPfGa1WxRzDyC",
    deadline: "2026-11-05T15:30:00.000Z",
    status: "completed",
    createdAt: "2026-11-05T13:30:00.000Z",
  },
];

export const PAID_FROM_ACCOUNTS: PaidFromAccount[] = [
  account(611, "Founder's Visa card", "card"),
  account(612, "KCB current account", "bank"),
  account(613, "Office M-Pesa till", "mobile_money"),
];

function account(
  n: number,
  name: string,
  kind: PaidFromAccount["kind"],
): PaidFromAccount {
  return {
    id: sampleId(n),
    name,
    kind,
    archived: false,
    createdAt: "2026-06-02T08:00:00.000Z",
    updatedAt: "2026-06-02T08:00:00.000Z",
  };
}

/** A Nairobi wall-clock time, 3 hours ahead of UTC. */
function at(day: string, time: string): string {
  const moment = new Date(`${day}T${time}:00+03:00`);
  return moment.toISOString();
}

/** USDC as base units, from the mock's dollars and cents. */
function usdc(amount: number): string {
  return String(Math.round(amount * 100) * 10_000);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A NEAR transaction hash: 44 base58 characters, in both cases. */
function nearHash(n: number): string {
  return Array.from(
    { length: 44 },
    (_, index) => BASE58[(n * 7 + index * 11) % BASE58.length] ?? "1",
  ).join("");
}

function baseHash(n: number): string {
  return `0x${n.toString(16).padStart(4, "0").repeat(16)}`;
}

const BATCH = sampleId(690);
const PAYROLL_BATCH = sampleId(691);
const PAYROLL_RUN = sampleId(692);

function payout(
  n: number,
  fields: Partial<WalletHistoryPayout> &
    Pick<
      WalletHistoryPayout,
      "recipientName" | "recipientDetail" | "amountKesCents" | "status"
    >,
): WalletHistoryPayout {
  return {
    id: sampleId(700 + n),
    subjectType: "bill",
    method: "mpesa_paybill",
    subjectId: sampleId(800 + n),
    recipientChain: null,
    payrollRunId: null,
    approvalId: null,
    approvedAt: null,
    paidAt: null,
    categoryName: null,
    paymentReceipts: [],
    rate: KES_RATE,
    failureReason: null,
    ...fields,
  };
}

function row(
  n: number,
  type: WalletHistoryItem["type"],
  amount: string,
  createdAt: string,
  extra: Partial<WalletHistoryItem> = {},
): WalletHistoryItem {
  return {
    id: sampleId(900 + n),
    type,
    usdcAmount: amount,
    chain: "near",
    txHash: nearHash(n),
    counterpartyAddress: null,
    createdAt,
    payout: null,
    ...extra,
  };
}

const ZUKU = payout(7, {
  recipientName: "Zuku",
  categoryName: "Airtime & internet",
  recipientDetail: "Paybill 320320, account 118-2219",
  amountKesCents: "410000",
  status: "failed",
  approvedAt: at("2026-11-04", "10:26"),
  failureReason: "The paybill didn't accept the account number.",
});

function salary(n: number, name: string, kes: number, amount: number) {
  return row(n, "payout", `-${usdc(amount)}`, at("2026-10-28", "10:00"), {
    payout: payout(n, {
      method: "mpesa_phone",
      recipientName: name,
      recipientDetail: `M-Pesa ending ${String(4000 + n).slice(-4)}`,
      amountKesCents: String(kes * 100),
      status: "paid",
      payrollRunId: PAYROLL_RUN,
      categoryName: "Salaries",
      approvalId: PAYROLL_BATCH,
      approvedAt: at("2026-10-28", "09:52"),
      paidAt: at("2026-10-28", "10:03"),
    }),
  });
}

/** Newest first, as the API sends them. */
export const LEDGER: WalletHistoryItem[] = [
  row(1, "payout", `-${usdc(1441.86)}`, at("2026-11-06", "09:20"), {
    payout: payout(1, {
      recipientName: "Twiga Foods",
      recipientDetail: "Paybill 222111, account TF-0091",
      amountKesCents: "18600000",
      categoryName: "Suppliers",
      status: "paying",
      approvalId: BATCH,
      approvedAt: at("2026-11-06", "09:18"),
    }),
  }),
  row(2, "payout", `-${usdc(155.04)}`, at("2026-11-06", "08:05"), {
    payout: payout(2, {
      subjectType: "float",
      method: "mpesa_phone",
      recipientName: "Kevin Mwangi",
      recipientDetail: "M-Pesa ending 0482",
      amountKesCents: "2000000",
      status: "funding",
      approvalId: BATCH,
      approvedAt: at("2026-11-06", "08:03"),
    }),
  }),
  row(3, "deposit", usdc(6000), at("2026-11-05", "16:42"), {
    counterpartyAddress: SENDER,
  }),
  row(4, "payout", `-${usdc(18.6)}`, at("2026-11-05", "11:10"), {
    payout: payout(4, {
      subjectType: "claim",
      method: "mpesa_phone",
      recipientName: "Daniel Kiprop",
      recipientDetail: "M-Pesa ending 0905",
      amountKesCents: "240000",
      status: "paid",
      approvedAt: at("2026-11-05", "11:08"),
      paidAt: at("2026-11-05", "11:12"),
    }),
  }),
  row(5, "payout", `-${usdc(110.47)}`, at("2026-11-04", "14:03"), {
    payout: payout(5, {
      recipientName: "Kenya Power",
      categoryName: "Rent & utilities",
      recipientDetail: "Paybill 888880, account 54012339",
      amountKesCents: "1425000",
      status: "paid",
      approvedAt: at("2026-11-04", "14:01"),
      paidAt: at("2026-11-04", "14:05"),
    }),
  }),
  row(6, "refund", usdc(31.78), at("2026-11-04", "10:31"), { payout: ZUKU }),
  row(7, "payout", `-${usdc(31.78)}`, at("2026-11-04", "10:28"), {
    payout: ZUKU,
  }),
  row(8, "withdrawal", `-${usdc(2000)}`, at("2026-11-03", "15:55"), {
    counterpartyAddress: ALLOWED_ADDRESSES[0]?.address ?? null,
    payout: payout(8, {
      subjectType: "withdrawal",
      method: "usdc",
      recipientName: "Reserve on Coinbase",
      recipientDetail: ALLOWED_ADDRESSES[0]?.address ?? "",
      recipientChain: "base",
      amountKesCents: "25800000",
      status: "paid",
      rate: null,
      approvedAt: at("2026-11-03", "15:54"),
      paidAt: at("2026-11-03", "15:55"),
    }),
  }),
  row(9, "payout", `-${usdc(500)}`, at("2026-11-01", "09:00"), {
    payout: payout(9, {
      recipientName: "Jubilee Health",
      categoryName: "Insurance",
      recipientDetail: "Paybill 511000, account JH-77812",
      amountKesCents: "6450000",
      status: "paid",
      approvedAt: at("2026-11-01", "08:57"),
      paidAt: at("2026-11-01", "09:02"),
    }),
  }),
  row(10, "deposit", usdc(12000), at("2026-10-31", "17:20"), {
    counterpartyAddress: SENDER,
  }),
  salary(11, "Wanjiru Kamau", 260_000, 2015.5),
  salary(12, "Faith Wambui", 250_000, 1937.98),
  salary(13, "Brian Otieno", 250_000, 1937.98),
  salary(14, "Peter Njoroge", 240_000, 1860.47),
  salary(15, "Joseph Kariuki", 240_000, 1860.47),
  row(16, "payout", `-${usdc(930.23)}`, at("2026-10-25", "12:15"), {
    payout: payout(16, {
      method: "bank",
      recipientName: "Bidco Kenya",
      categoryName: "Suppliers",
      recipientDetail: "Equity Bank account ending 2210",
      amountKesCents: "12000000",
      status: "paid",
      approvedAt: at("2026-10-25", "12:12"),
      paidAt: at("2026-10-25", "12:40"),
    }),
  }),
  row(17, "deposit", usdc(2000), at("2026-10-20", "09:45"), {
    chain: "base",
    txHash: baseHash(17),
    counterpartyAddress: BASE_SENDER,
  }),
  row(18, "payout", `-${usdc(375.97)}`, at("2026-10-15", "08:30"), {
    payout: payout(18, {
      recipientName: "Kilimani Properties",
      categoryName: "Rent & utilities",
      recipientDetail: "Paybill 522522, account KP-1182",
      amountKesCents: "4850000",
      status: "paid",
      approvedAt: at("2026-10-15", "08:28"),
      paidAt: at("2026-10-15", "08:33"),
    }),
  }),
  row(19, "payout", `-${usdc(759.69)}`, at("2026-10-10", "13:05"), {
    payout: payout(19, {
      recipientName: "Twiga Foods",
      recipientDetail: "Paybill 222111, account TF-0091",
      amountKesCents: "9800000",
      categoryName: "Suppliers",
      status: "paid",
      approvedAt: at("2026-10-10", "13:02"),
      paidAt: at("2026-10-10", "13:08"),
    }),
  }),
  row(20, "deposit", usdc(2500), at("2026-10-08", "10:00"), {
    chain: "base",
    txHash: baseHash(20),
    counterpartyAddress: BASE_SENDER,
  }),
];

/** The first page stops at 1 Nov, as the mock's does, so "Load more" shows. */
const FIRST_PAGE = 9;

function pages(
  ...responses: WalletHistoryResponse[]
): InfiniteData<WalletHistoryResponse> {
  return {
    pages: responses,
    pageParams: responses.map((_, index) =>
      index === 0 ? null : (responses[index - 1]?.nextCursor ?? null),
    ),
  };
}

export function seedWallet(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  client.setQueryData(walletKeys.summary(org), ACCOUNTS_WALLET);
  client.setQueryData(
    walletKeys.history(org),
    pages({
      items: LEDGER.slice(0, FIRST_PAGE),
      nextCursor: LEDGER[FIRST_PAGE - 1]?.id ?? null,
    }),
  );
  client.setQueryData(
    walletKeys.balanceHistory(org),
    pages({ items: LEDGER, nextCursor: null }),
  );
  client.setQueryData(walletKeys.addresses(org), ALLOWED_ADDRESSES);
  client.setQueryData(walletKeys.fundIns(org), FUND_INS);
  for (const fundIn of FUND_INS) {
    client.setQueryData(walletKeys.fundIn(org, fundIn.id), fundIn);
  }
  client.setQueryData(billKeys.paidFromAccounts(org), PAID_FROM_ACCOUNTS);
}
