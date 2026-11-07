import type { QueryClient } from "@tanstack/react-query";

import type {
  CashObligation,
  FloatsResponse,
  FloatSummary,
  LargestPayment,
  ReportSpending,
  SpendingByHeading,
  SpendingOverview,
} from "@expendi-business/shared";

import { overviewKeys } from "~/app/(company)/overview/_components/overview-api";
import { defaultOverviewMonth } from "~/app/(company)/overview/_components/overview-view";
import { ORGANIZATION_ID, sampleId, TODAY } from "./company";

/** Whole shillings as the API's KES cents. */
const kes = (shillings: number) => String(Math.round(shillings * 100));

const obligation = (
  n: number,
  fields: Partial<CashObligation> &
    Pick<CashObligation, "name" | "dueOn" | "amountKes">,
): CashObligation => ({
  id: sampleId(1200 + n),
  kind: "bill",
  notes: null,
  schedule: null,
  people: null,
  status: fields.dueOn < TODAY ? "overdue" : "unpaid",
  payVia: "expendi",
  needsAmount: false,
  heading: "transactions",
  ...fields,
});

const RENT = obligation(1, {
  name: "Kilimani Properties",
  notes: "Office rent for November",
  dueOn: "2026-11-01",
  amountKes: kes(48_500),
});
const FIBRE = obligation(2, {
  name: "Safaricom",
  notes: "Home Fibre for November",
  dueOn: "2026-11-06",
  amountKes: kes(6_999),
  heading: "subscriptions",
});

/** Due through 6 Dec, overdue first, as the cash check lists them. */
const OBLIGATIONS: CashObligation[] = [
  RENT,
  FIBRE,
  obligation(3, {
    name: "KRA",
    notes: "PAYE for October",
    dueOn: "2026-11-09",
    amountKes: kes(212_400),
    heading: "salaries",
  }),
  obligation(4, {
    name: "Nairobi Water",
    notes: "Water bill",
    schedule: "monthly",
    dueOn: "2026-11-15",
    amountKes: kes(3_850),
  }),
  obligation(5, {
    name: "Zuku",
    notes: "Office internet",
    schedule: "monthly",
    dueOn: "2026-12-02",
    amountKes: kes(4_100),
    heading: "subscriptions",
  }),
  obligation(6, {
    name: "Twiga Foods",
    notes: "Supplier invoice INV-4502",
    dueOn: "2026-12-04",
    amountKes: kes(186_000),
  }),
  obligation(7, {
    name: "Safaricom",
    notes: "Staff airtime",
    schedule: "monthly",
    dueOn: "2026-12-05",
    amountKes: kes(9_613),
    heading: "subscriptions",
  }),
  obligation(8, {
    name: "Kenya Power",
    notes: "Electricity",
    dueOn: "2026-11-29",
    amountKes: kes(14_250),
  }),
  obligation(9, {
    kind: "payroll",
    name: "Payroll",
    notes: null,
    people: 14,
    dueOn: "2026-11-28",
    amountKes: kes(1_240_000),
    heading: "salaries",
  }),
  obligation(10, {
    name: "Bolt Business",
    notes: "Staff rides",
    dueOn: "2026-11-30",
    amountKes: kes(12_000),
  }),
  obligation(11, {
    name: "Jubilee Health",
    notes: "Staff medical cover",
    schedule: "monthly",
    dueOn: "2026-12-01",
    amountKes: kes(64_500),
  }),
  obligation(12, {
    name: "Kilimani Properties",
    notes: "Office rent for December",
    schedule: "monthly",
    dueOn: "2026-12-01",
    amountKes: kes(48_500),
  }),
  obligation(13, {
    name: "Google Workspace",
    notes: "14 seats",
    schedule: "monthly",
    dueOn: "2026-12-03",
    amountKes: kes(9_288),
    heading: "subscriptions",
  }),
];

const expense = (
  n: number,
  fields: Omit<
    SpendingOverview["outstanding"]["claims"][number],
    "id" | "floatId"
  > & { readonly float?: boolean },
): SpendingOverview["outstanding"]["claims"][number] => {
  const { float, ...rest } = fields;
  return {
    id: sampleId(1300 + n),
    floatId: float ? sampleId(1400 + n) : null,
    ...rest,
  };
};

const breakdown = (
  id: string,
  name: string,
  current: number,
  previous: number,
) => ({ id, name, currentKes: kes(current), previousKes: kes(previous) });

/** `GET /overview?month=2026-10`, as the overview mock shows it on 6 Nov 2026. */
export const OVERVIEW: SpendingOverview = {
  month: "2026-10",
  previousMonth: "2026-09",
  currentKes: kes(1_920_000),
  previousKes: kes(1_838_000),
  headings: [
    breakdown("petty_cash", "Petty cash", 72_000, 61_100),
    breakdown("transactions", "Transactions", 581_808, 510_901),
    breakdown("salaries", "Salaries & personnel", 1_240_000, 1_240_000),
    breakdown("subscriptions", "Subscriptions", 26_192, 25_999),
  ],
  categories: [
    breakdown(sampleId(1501), "Salaries", 1_240_000, 1_240_000),
    breakdown(sampleId(1502), "Suppliers", 286_000, 262_000),
    breakdown(sampleId(1503), "Fuel & transport", 162_000, 124_000),
    breakdown(sampleId(1504), "Rent & utilities", 98_000, 98_000),
    breakdown(sampleId(1505), "Office & supplies", 64_000, 58_000),
    breakdown(sampleId(1506), "Airtime & internet", 38_000, 36_000),
    breakdown(sampleId(1507), "Software", 15_093, 14_900),
    breakdown(sampleId(1508), "Meals & entertainment", 9_407, 2_600),
    breakdown(sampleId(1509), "Repairs & maintenance", 7_500, 2_500),
  ],
  recentPayments: [],
  outstanding: {
    overdue: [RENT],
    dueToday: [FIBRE],
    claims: [
      expense(1, {
        name: "Java House",
        amountKes: kes(3_200),
        spentOn: "2026-11-04",
        personName: "Brian Otieno",
        categoryName: "Meals & entertainment",
        description: "Client lunch",
      }),
      expense(2, {
        name: "Matatu fares",
        amountKes: kes(1_450),
        spentOn: "2026-11-05",
        personName: "Faith Wambui",
        categoryName: "Fuel & transport",
        description: null,
      }),
    ],
    noReceipt: [
      expense(3, {
        name: "Rubis Westlands",
        amountKes: kes(4_850),
        spentOn: "2026-11-03",
        personName: "Kevin Mwangi",
        categoryName: "Fuel & transport",
        description: "Fuel",
        float: true,
      }),
    ],
    noEtims: [
      expense(4, {
        name: "Naivas Sarit",
        amountKes: kes(2_300),
        spentOn: "2026-11-02",
        personName: "Grace Achieng",
        categoryName: "Office & supplies",
        description: "Office supplies",
        float: true,
      }),
    ],
  },
  cash: {
    today: TODAY,
    through: "2026-12-06",
    totalKes: kes(1_860_000),
    unknownAmounts: 0,
    obligations: OBLIGATIONS,
    balanceUsdc: "16420800000",
    reservedUsdc: "1742325581",
    balanceKes: "211828320",
    availableKes: "189352320",
    rate: "129",
    status: "covered",
    shortKes: null,
    outsideKes: "0",
  },
  people: [
    { id: sampleId(1601), name: "Brian Otieno" },
    { id: sampleId(1602), name: "Faith Wambui" },
    { id: sampleId(1603), name: "Grace Achieng" },
    { id: sampleId(1604), name: "Kevin Mwangi" },
  ],
};

const float = (
  n: number,
  name: string,
  issued: number,
  left: number,
  spending: number,
  noReceipt: number,
): FloatSummary => ({
  id: sampleId(1700 + n),
  status: "open",
  holder: {
    membershipId: sampleId(1710 + n),
    name,
    email: `${name.split(/[ ,]/)[0]?.toLowerCase() ?? "float"}@mwangaza.co.ke`,
  },
  yours: false,
  openedAt: "2026-09-01T07:00:00.000Z",
  closedAt: null,
  issuedKes: kes(issued),
  spentKes: kes(issued - left),
  returnedKes: "0",
  writtenOffKes: "0",
  leftKes: kes(left),
  onTheWayKes: "0",
  awaitingApprovalKes: "0",
  spendingCount: spending,
  noReceiptCount: noReceipt,
});

export const OPEN_FLOATS: FloatsResponse = {
  floats: [
    float(1, "Kevin Mwangi", 20_000, 8_150, 9, 1),
    float(2, "Grace Achieng", 15_000, 2_700, 12, 0),
    float(3, "Site team, Machakos", 50_000, 31_000, 6, 0),
  ],
};

const MONTHS = [
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2026-10",
] as const;

/** Each category's money out per month, by heading, in whole shillings. */
const CATEGORY_MONTHS: Record<
  string,
  readonly (readonly [keyof SpendingByHeading, readonly number[]])[]
> = {
  Salaries: [
    [
      "salaries",
      [
        1_180_000, 1_180_000, 1_240_000, 1_240_000, 1_240_000, 1_240_000,
        1_240_000,
      ],
    ],
  ],
  Suppliers: [
    [
      "transactions",
      [231_000, 248_000, 255_000, 271_000, 244_000, 262_000, 286_000],
    ],
  ],
  "Fuel & transport": [
    ["transactions", [81_000, 92_000, 85_000, 97_000, 90_000, 88_000, 122_000]],
    ["petty_cash", [31_000, 33_000, 30_500, 38_000, 35_000, 36_000, 40_000]],
  ],
  "Rent & utilities": [
    ["transactions", [98_000, 98_000, 98_000, 98_000, 98_000, 98_000, 98_000]],
  ],
  "Office & supplies": [
    ["transactions", [35_000, 39_500, 41_000, 36_000, 40_500, 38_000, 42_000]],
    ["petty_cash", [18_000, 19_500, 21_000, 17_500, 22_000, 20_000, 22_000]],
  ],
  "Airtime & internet": [
    ["subscriptions", [11_099, 11_099, 11_099, 11_099, 11_099, 11_099, 11_099]],
    ["transactions", [22_500, 23_800, 25_100, 24_400, 26_300, 24_901, 26_901]],
  ],
  Software: [
    ["subscriptions", [14_900, 14_900, 14_900, 14_900, 14_900, 14_900, 15_093]],
  ],
  "Meals & entertainment": [
    ["transactions", [4_100, 3_600, 5_200, 4_800, 3_900, 0, 5_407]],
    ["petty_cash", [2_100, 3_000, 2_400, 2_900, 3_300, 2_600, 4_000]],
  ],
  "Repairs & maintenance": [
    ["transactions", [0, 1_200, 0, 2_800, 0, 0, 1_500]],
    ["petty_cash", [3_100, 2_400, 4_200, 1_900, 2_700, 2_500, 6_000]],
  ],
  Equipment: [["transactions", [0, 86_500, 0, 0, 0, 0, 0]]],
};

const CATEGORY_IDS: Record<string, string> = Object.fromEntries(
  Object.keys(CATEGORY_MONTHS).map((name, index) => [
    name,
    sampleId(1501 + index),
  ]),
);

function monthOf(
  month: string,
  rows: readonly (readonly [keyof SpendingByHeading, readonly number[]])[],
  index: number,
  payments: number,
): ReportSpending["months"][number] {
  const headings: Record<keyof SpendingByHeading, number> = {
    petty_cash: 0,
    transactions: 0,
    salaries: 0,
    subscriptions: 0,
  };
  for (const [heading, values] of rows) headings[heading] += values[index] ?? 0;
  const total = Object.values(headings).reduce((sum, value) => sum + value, 0);
  return {
    month,
    totalKes: kes(total),
    payments,
    headings: {
      petty_cash: kes(headings.petty_cash),
      transactions: kes(headings.transactions),
      salaries: kes(headings.salaries),
      subscriptions: kes(headings.subscriptions),
    },
  };
}

const ALL_ROWS = Object.values(CATEGORY_MONTHS).flat();

const payment = (
  n: number,
  category: string,
  fields: Pick<LargestPayment, "kind" | "name" | "date" | "personName"> & {
    readonly amount: number;
  },
): LargestPayment => ({
  id: sampleId(1800 + n),
  subjectId: sampleId(1850 + n),
  kind: fields.kind,
  name: fields.name,
  date: fields.date,
  amountKes: kes(fields.amount),
  categoryId: CATEGORY_IDS[category] ?? sampleId(1500),
  personName: fields.personName,
});

/** `GET /reports/spending?month=2026-10&months=6`: April is there to compare May with. */
export const SPENDING_TREND: ReportSpending = {
  month: "2026-10",
  today: TODAY,
  months: MONTHS.map((month, index) =>
    monthOf(month, ALL_ROWS, index, 40 + index * 3),
  ),
  categories: Object.entries(CATEGORY_MONTHS).map(([name, rows]) => ({
    id: CATEGORY_IDS[name] ?? name,
    name,
    months: MONTHS.map((month, index) => monthOf(month, rows, index, 4)),
  })),
  largestPayments: [
    payment(1, "Salaries", {
      kind: "bill",
      name: "Wanjiru Kamau",
      date: "2026-10-28",
      personName: "Wanjiru Kamau",
      amount: 220_000,
    }),
    payment(2, "Suppliers", {
      kind: "bill",
      name: "Bidco Kenya",
      date: "2026-10-25",
      personName: null,
      amount: 120_000,
    }),
    payment(3, "Suppliers", {
      kind: "bill",
      name: "Twiga Foods",
      date: "2026-10-10",
      personName: null,
      amount: 98_000,
    }),
    payment(4, "Suppliers", {
      kind: "bill",
      name: "Unga Limited",
      date: "2026-10-18",
      personName: null,
      amount: 68_000,
    }),
    payment(5, "Rent & utilities", {
      kind: "bill",
      name: "Kilimani Properties",
      date: "2026-10-15",
      personName: null,
      amount: 48_500,
    }),
    payment(6, "Fuel & transport", {
      kind: "company",
      name: "TotalEnergies Kenya",
      date: "2026-10-22",
      personName: null,
      amount: 20_000,
    }),
    payment(7, "Fuel & transport", {
      kind: "float",
      name: "Rubis Westlands",
      date: "2026-10-12",
      personName: "Kevin Mwangi",
      amount: 8_400,
    }),
    payment(8, "Office & supplies", {
      kind: "claim",
      name: "Text Book Centre",
      date: "2026-10-08",
      personName: "Grace Achieng",
      amount: 12_600,
    }),
  ],
};

/** The overview's reads, under the month the page opens on. */
export function seedOverview(client: QueryClient): void {
  const month = defaultOverviewMonth(new Date());
  client.setQueryData(overviewKeys.month(ORGANIZATION_ID, month), OVERVIEW);
  client.setQueryData(
    overviewKeys.trend(ORGANIZATION_ID, month),
    SPENDING_TREND,
  );
  client.setQueryData(overviewKeys.openFloats(ORGANIZATION_ID), OPEN_FLOATS);
}
