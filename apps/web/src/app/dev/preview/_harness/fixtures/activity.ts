import type { QueryClient } from "@tanstack/react-query";

import type { ActivityEntry, ActivityPage } from "@expendi-business/shared";

import { activityKeys } from "~/app/(company)/activity/_components/activity-api";
import { ORGANIZATION_ID, sampleId } from "./company";

/** The people who act in docs/mocks/activity.html, by their user IDs. */
const PEOPLE = {
  wk: { id: sampleId(9401), name: "Wanjiru Kamau" },
  lm: { id: sampleId(9402), name: "Lucy Mutua" },
  fw: { id: sampleId(9403), name: "Faith Wambui" },
  km: { id: sampleId(9404), name: "Kevin Mwangi" },
  ga: { id: sampleId(9405), name: "Grace Achieng" },
  dk: { id: sampleId(9406), name: "Daniel Kiprop" },
  pn: { id: sampleId(9407), name: "Peter Njoroge" },
  ah: { id: sampleId(9408), name: "Amina Hassan" },
} as const;

type Who = keyof typeof PEOPLE | "system" | "staff";

function actorOf(who: Who): ActivityEntry["actor"] {
  if (who === "system" || who === "staff") {
    return { type: who, id: null, name: null };
  }
  return { type: "user", ...PEOPLE[who] };
}

let next = 9500;
const uid = () => sampleId((next += 1));

/** A record the log points at, with the name the API gives it. */
const record = (type: string, label: string | null) => ({
  type,
  id: uid(),
  label,
});

const R = {
  exportOct: record("report_export", "October 2026 export"),
  payTwiga: record("payout", "Payment to Twiga Foods"),
  billTwiga: record("bill", "Twiga Foods, INV-4471"),
  floatKevin: record("float", "Kevin Mwangi's petty cash"),
  payeeBidco: record("payee", "Bidco Kenya"),
  wallet: { type: "wallet", id: null, label: null },
  expParking: record("expense", "Parking at JKIA, Daniel Kiprop"),
  expUberAmina: record("expense", "Uber, Amina Hassan"),
  expMatatu: record("expense", "Matatu fares, Faith Wambui"),
  memJoseph: record("membership", "Joseph Kariuki"),
  billKpl: record("bill", "Kenya Power, 54012339"),
  billZuku: record("bill", "Zuku, 118-2219"),
  payWithdraw: record("payout", "Withdrawal to Treasury on Coinbase"),
  expRubisFloat: record("expense", "Rubis Westlands, Kevin Mwangi"),
  expRubis: record("expense", "Rubis Westlands, Kevin Mwangi"),
  payeeCarmax: record("payee", "CarMax Mechanics"),
  billCarmax: record("bill", "CarMax Mechanics, JOB-7712"),
  catAirtime: record("category", "Airtime & internet"),
  expNaivasSarit: record("expense", "Naivas Sarit, Grace Achieng"),
  billJubilee: record("bill", "Jubilee Health, Staff medical cover"),
  billGoogle: record("bill", "Google Workspace, November"),
  expNaivasKil: record("expense", "Naivas Kilimani, Peter Njoroge"),
  expUberWanjiru: record("expense", "Uber, Wanjiru Kamau"),
  runOct: record("payroll_run", "Payroll for October 2026"),
  salaryKevin: record("recurring_item", "Kevin Mwangi"),
  org: record("organization", "Mwangaza Logistics"),
  recCanva: record("recurring_item", "Canva, Monthly"),
  billCanva: record("bill", "Canva, October"),
} as const;

const SENDER = "mwangaza-treasury.near";
const kes = (shillings: number) => String(Math.round(shillings * 100));

/** Nairobi wall-clock time, 3 hours ahead of UTC, to the API's microseconds. */
const at = (nairobi: string) =>
  new Date(`${nairobi.replace(" ", "T")}:00+03:00`)
    .toISOString()
    .replace(".000Z", ".000000Z");

function entry(
  when: string,
  who: Who,
  action: string,
  entity: ActivityEntry["entity"],
  values: {
    before?: ActivityEntry["before"];
    after?: ActivityEntry["after"];
  } = {},
  approvalId: string | null = null,
): ActivityEntry {
  return {
    id: uid(),
    occurredAt: at(when),
    actor: actorOf(who),
    action,
    entity,
    approvalId,
    before: values.before ?? null,
    after: values.after ?? null,
  };
}

/** A bill approved for payment, and the payment behind it, as the API records them. */
function billApproval(
  when: string,
  bill: ActivityEntry["entity"],
  prior: string,
  amount: { kes: number } | { usd: number },
  approvalId: string,
): ActivityEntry[] {
  const kesCents =
    "kes" in amount ? kes(amount.kes) : String(Math.floor(amount.usd * 12_900));
  const payout = record("payout", null);
  return [
    entry(
      when,
      "wk",
      "payout.approved",
      payout,
      { after: { approvalId, amountKes: kesCents, maxDebitUsdc: null } },
      approvalId,
    ),
    entry(
      when,
      "wk",
      "bill.payment_approved",
      bill,
      {
        before: { status: prior },
        after: {
          status: "paying",
          payoutId: payout.id,
          approvalId,
          currency: "kes" in amount ? "kes" : "usd",
          amountKes: "kes" in amount ? kesCents : null,
          amountUsdc:
            "usd" in amount ? String(Math.round(amount.usd * 1_000_000)) : null,
          kesEquivalent: kesCents,
        },
      },
      approvalId,
    ),
  ];
}

function expenseApproval(
  when: string,
  expense: ActivityEntry["entity"],
  shillings: number,
  selfApproval = false,
): ActivityEntry[] {
  const approvalId = uid();
  const payout = record("payout", null);
  return [
    entry(
      when,
      "wk",
      "payout.approved",
      payout,
      { after: { approvalId, amountKes: kes(shillings) } },
      approvalId,
    ),
    entry(
      when,
      "wk",
      "expense.approved",
      expense,
      {
        before: { status: "submitted" },
        after: {
          status: "paying",
          payoutId: payout.id,
          approvalId,
          amountKes: kes(shillings),
          selfApproval,
        },
      },
      approvalId,
    ),
  ];
}

const paid = (from = "paying") => ({
  before: { status: from },
  after: { status: "paid" },
});

const submitted = (
  merchant: string,
  category: string,
  spentOn: string,
  shillings: number,
  extra: Record<string, ActivityEntry["after"]> = {},
) => ({
  after: {
    status: "submitted",
    merchant,
    category,
    spentOn,
    amountKes: kes(shillings),
    ...extra,
  },
});

const batchApproval = uid();

/** `GET …/activity`, newest first, as in docs/mocks/activity.html. */
export const ACTIVITY_ENTRIES: ActivityEntry[] = [
  entry("2026-11-06 09:41", "lm", "report_export.generated", R.exportOct, {
    after: {
      month: "2026-10",
      monthly: false,
      linkId: uid(),
      expiresAt: "2026-11-13T06:41:00.000Z",
    },
  }),
  entry("2026-11-06 09:20", "system", "payout.paying", R.payTwiga, {
    before: { status: "funded" },
    after: { status: "paying", amountKes: kes(186_000) },
  }),
  ...billApproval(
    "2026-11-06 09:18",
    R.billTwiga,
    "overdue",
    { kes: 186_000 },
    uid(),
  ),
  entry("2026-11-06 08:05", "wk", "float.payment_approved", R.floatKevin, {
    after: {
      type: "top_up",
      approvalId: null,
      amountKes: kes(20_000),
      selfApproval: false,
    },
  }),
  entry("2026-11-06 08:03", "wk", "float.top_up_prepared", R.floatKevin, {
    after: {
      amountKes: kes(20_000),
      note: "Fuel for the Thika deliveries this week.",
    },
  }),
  entry("2026-11-05 17:48", "wk", "payee.updated", R.payeeBidco, {
    before: {
      kind: "supplier",
      name: "Bidco Kenya",
      details: { method: "paybill", paybill: "400200", account: "BID-2210" },
    },
    after: {
      kind: "supplier",
      name: "Bidco Kenya",
      details: {
        method: "bank",
        bankName: "Equity Bank",
        accountNumber: "••••••4321",
      },
    },
  }),
  entry("2026-11-05 16:42", "system", "wallet.deposit_received", R.wallet, {
    after: {
      amountUsdc: "6000000000",
      from: SENDER,
      chain: "near",
      txHash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    },
  }),
  entry("2026-11-05 11:10", "system", "expense.paid", R.expParking, paid()),
  ...expenseApproval("2026-11-05 11:08", R.expParking, 2_400),
  entry(
    "2026-11-05 10:05",
    "ah",
    "expense.submitted",
    R.expUberAmina,
    submitted("Uber", "Fuel & transport", "2026-11-05", 1_280),
  ),
  entry(
    "2026-11-05 09:30",
    "fw",
    "expense.submitted",
    R.expMatatu,
    submitted("Matatu fares", "Fuel & transport", "2026-11-05", 1_450, {
      noReceiptReason: "Matatus don't give receipts.",
    }),
  ),
  entry("2026-11-04 15:20", "wk", "membership.invited", R.memJoseph, {
    after: {
      email: "joseph@mwangaza.co.ke",
      fullName: "Joseph Kariuki",
      role: "employee",
      status: "invited",
    },
  }),
  entry("2026-11-04 14:05", "system", "bill.paid", R.billKpl, paid()),
  ...billApproval("2026-11-04 14:03", R.billKpl, "due", { kes: 14_250 }, uid()),
  entry("2026-11-04 10:30", "system", "bill.payout_failed", R.billZuku, {
    before: { status: "paying" },
    after: {
      status: "payout_failed",
      reason: "The paybill didn't accept the account number.",
    },
  }),
  ...billApproval("2026-11-04 10:28", R.billZuku, "due", { kes: 4_100 }, uid()),
  entry("2026-11-03 15:53", "wk", "payout.prepared", R.payWithdraw, {
    after: {
      status: "prepared",
      kind: "withdrawal",
      amountUsdc: "2000000000",
      to: "0x12ab7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99f3c",
      chain: "base",
    },
  }),
  entry("2026-11-03 11:00", "km", "expense.recorded", R.expRubisFloat, {
    after: {
      status: "recorded",
      merchant: "Rubis Westlands",
      category: "Fuel & transport",
      spentOn: "2026-11-03",
      amountKes: kes(4_850),
      pettyCash: true,
    },
  }),
  entry("2026-11-02 12:34", "wk", "bill.created", R.billCarmax, {
    after: {
      status: "upcoming",
      payee: "CarMax Mechanics",
      amountKes: kes(18_500),
      dueOn: "2026-11-22",
      category: "Repairs & maintenance",
      reference: "JOB-7712",
    },
  }),
  entry("2026-11-02 12:30", "wk", "payee.created", R.payeeCarmax, {
    after: { kind: "supplier", name: "CarMax Mechanics", details: null },
  }),
  entry("2026-11-02 10:15", "ga", "expense.recorded", R.expNaivasSarit, {
    after: {
      status: "recorded",
      merchant: "Naivas Sarit",
      category: "Office & supplies",
      spentOn: "2026-11-02",
      amountKes: kes(2_300),
      pettyCash: true,
    },
  }),
  entry("2026-11-02 09:12", "wk", "category.updated", R.catAirtime, {
    before: { name: "Phone & internet", etimsNotRequired: false },
    after: { name: "Airtime & internet", etimsNotRequired: false },
  }),
  entry(
    "2026-11-02 07:42",
    "km",
    "expense.submitted",
    R.expRubis,
    submitted("Rubis Westlands", "Fuel & transport", "2026-11-02", 5_000, {
      warnings: ["near_duplicate"],
    }),
  ),
  ...billApproval(
    "2026-11-01 09:00",
    R.billJubilee,
    "due",
    { kes: 64_500 },
    batchApproval,
  ),
  ...billApproval(
    "2026-11-01 09:00",
    R.billGoogle,
    "due",
    { usd: 72 },
    batchApproval,
  ),
  entry("2026-10-31 10:02", "system", "expense.payout_failed", R.expNaivasKil, {
    before: { status: "paying" },
    after: {
      status: "payout_failed",
      reason: "M-Pesa didn't accept the payment to 0722 ••• 615.",
    },
  }),
  ...expenseApproval("2026-10-31 10:00", R.expNaivasKil, 3_950),
  entry("2026-10-31 08:16", "system", "expense.paid", R.expUberWanjiru, paid()),
  ...expenseApproval("2026-10-31 08:15", R.expUberWanjiru, 1_180, true),
  entry("2026-10-28 10:02", "system", "payroll_run.status_changed", R.runOct, {
    before: { status: "paying" },
    after: { status: "paid", paid: 14, failed: 0 },
  }),
  entry("2026-10-27 16:20", "wk", "salary.amount_changed", R.salaryKevin, {
    before: { amountKes: kes(38_000) },
    after: { amountKes: kes(42_000) },
  }),
  entry(
    "2026-10-27 15:50",
    "wk",
    "organization.payroll_margin_changed",
    R.org,
    {
      before: { payrollMarginPercent: 20 },
      after: { payrollMarginPercent: 25 },
    },
  ),
  entry("2026-10-18 11:06", "wk", "recurring_item.ended", R.recCanva, {
    after: { endedOn: "2026-10-18" },
  }),
  entry("2026-10-18 11:05", "wk", "bill.cancelled", R.billCanva, {
    before: { status: "upcoming" },
    after: {
      status: "cancelled",
      reason: "Subscription cancelled; the team moved to Figma.",
    },
  }),
  entry("2026-10-13 01:10", "staff", "payee.restored", R.payeeBidco, {
    before: { archived: true },
    after: { archived: false },
  }),
];

export const ACTIVITY_PAGE: ActivityPage = {
  entries: ACTIVITY_ENTRIES,
  nextCursor: null,
};

export function seedActivity(client: QueryClient): void {
  client.setQueryData(activityKeys.list(ORGANIZATION_ID, {}), {
    pages: [ACTIVITY_PAGE],
    pageParams: [null],
  });
}
