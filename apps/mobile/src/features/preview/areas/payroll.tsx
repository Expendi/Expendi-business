/** DEV PREVIEW — admin Payroll and the employee Pay and Petty cash tabs. */
import type { JSX } from "react";

import type { PreviewArea, PreviewRoute } from "../types";
import { MyPettyCashScreen } from "~/features/petty-cash/my-petty-cash-screen";
import { MyPayScreen } from "~/features/payroll/my-pay-screen";
import { PayrollScreen } from "~/features/payroll/payroll-screen";
import { previewSession } from "../session";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "../types";

const RUNS = /\/payroll-runs$/;
const SALARIES = /\/salaries$/;
const MY_PAYMENTS = /\/me\/salary-payments$/;
const MY_FLOATS = /\/floats\?mine=true$/;
const FLOAT_DETAIL = /\/floats\/[0-9a-f-]+$/;

const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const run = (
  n: number,
  payDate: string,
  status: "draft" | "paying" | "paid" | "partly_failed",
  totalKes: string,
  people: number,
) => ({
  id: id(100 + n),
  payDate,
  status,
  totalKes,
  salariesKes: totalKes,
  capKes: (BigInt(totalKes) + 1_000_000n).toString(),
  people,
  leftOut: 0,
  adjusted: 0,
  oneOffs: 0,
  progress: {
    paid: status === "paid" ? people : 0,
    paying: 0,
    failed: 0,
  },
  createdAt: "2026-10-23T08:00:00.000Z",
  approvedAt: status === "draft" ? null : "2026-10-24T08:00:00.000Z",
});

const salary = (
  n: number,
  name: string,
  method: "mpesa_phone" | "bank",
  amountKes: string,
  state: "active" | "paused" | "ended" = "active",
) => ({
  id: id(200 + n),
  state,
  payee: {
    id: id(300 + n),
    name,
    kind: "employee",
    method,
    archived: false,
    payoutPhoneConfirmed: true,
    accountEnding: method === "bank" ? "4471" : null,
  },
  category: { id: id(400), name: "Salaries" },
  amountKes,
  payDay: 28,
  startsOn: "2026-01-01",
  endsOn: null,
  nextPayDate: state === "active" ? "2026-11-28" : null,
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: "2026-01-01T08:00:00.000Z",
});

const SALARY_LIST = [
  salary(1, "Faith Njeri", "mpesa_phone", "6800000"),
  salary(2, "Brian Otieno", "mpesa_phone", "3250000"),
  salary(3, "Achieng’ Odhiambo", "mpesa_phone", "2800000"),
  salary(4, "Kevin Mwangi", "bank", "2432100"),
  salary(5, "Mercy Wanjiku", "mpesa_phone", "2100000"),
  salary(6, "Otieno Ouma", "mpesa_phone", "1800000", "paused"),
];

const RUN_LIST = [
  run(1, "2026-11-28", "draft", "21432100", 7),
  run(2, "2026-10-28", "paid", "21432100", 7),
  run(3, "2026-09-28", "paid", "20980000", 7),
];

const payrollRoutes = (
  runs: unknown,
  salaries: unknown,
): readonly PreviewRoute[] => [
  { path: RUNS, data: runs },
  { path: SALARIES, data: salaries },
];

function Payroll(): JSX.Element {
  const { state } = previewSession("admin");
  if (state.status !== "ready") throw new Error("preview session");
  return <PayrollScreen company={state.company} />;
}

const payment = (
  n: number,
  payDate: string,
  status: "paying" | "paid" | "payout_failed",
  amountKes: string,
  kind: "salary" | "one_off" = "salary",
) => ({
  id: id(500 + n),
  kind,
  payDate,
  amountKes,
  status,
  paidOn: status === "paid" ? payDate : null,
});

const PAYMENTS = [
  payment(1, "2026-11-06", "paid", "218000"),
  payment(2, "2026-10-06", "paid", "218000"),
  payment(3, "2026-10-20", "paid", "50000", "one_off"),
];

function MyPay(): JSX.Element {
  const { state } = previewSession("employee");
  if (state.status !== "ready") throw new Error("preview session");
  return <MyPayScreen company={state.company} layout="tab" />;
}

const FLOAT_ID = id(600);

const floatSummary = {
  id: FLOAT_ID,
  status: "open",
  holder: {
    membershipId: id(601),
    name: "Brian Otieno",
    email: "brian@mawingulabs.co.ke",
  },
  yours: true,
  openedAt: "2026-11-02T08:00:00.000Z",
  closedAt: null,
  issuedKes: "500000",
  spentKes: "138000",
  returnedKes: "0",
  writtenOffKes: "0",
  leftKes: "362000",
  onTheWayKes: "0",
  awaitingApprovalKes: "0",
  spendingCount: 3,
  noReceiptCount: 1,
};

const floatDetail = {
  ...floatSummary,
  movements: [
    {
      id: id(610),
      type: "issue",
      status: "paid",
      phase: "paid",
      amountKes: "500000",
      note: null,
      recordedBy: "Wanjiru Kamau",
      createdAt: "2026-11-02T08:05:00.000Z",
      paidAt: "2026-11-02T08:06:00.000Z",
      payout: null,
    },
  ],
  spending: [
    {
      id: id(620),
      merchant: "Naivas Westlands",
      amountKes: "64000",
      spentOn: "2026-11-09",
      description: null,
      category: { id: id(630), name: "Office supplies" },
      etimsStatus: "attached",
      noReceipt: false,
      noReceiptReason: null,
      receiptCount: 1,
      overspendClaim: null,
      warnings: [],
      createdAt: "2026-11-09T10:00:00.000Z",
    },
    {
      id: id(621),
      merchant: "Kahawa Corner",
      amountKes: "24000",
      spentOn: "2026-11-06",
      description: null,
      category: { id: id(631), name: "Meals" },
      etimsStatus: "none",
      noReceipt: true,
      noReceiptReason: "Vendor gave none",
      receiptCount: 0,
      overspendClaim: null,
      warnings: [],
      createdAt: "2026-11-06T13:00:00.000Z",
    },
    {
      id: id(622),
      merchant: "Shell Lang’ata",
      amountKes: "50000",
      spentOn: "2026-11-04",
      description: null,
      category: { id: id(632), name: "Fuel" },
      etimsStatus: "attached",
      noReceipt: false,
      noReceiptReason: null,
      receiptCount: 1,
      overspendClaim: null,
      warnings: [],
      createdAt: "2026-11-04T09:00:00.000Z",
    },
  ],
  overspendClaims: [],
};

const floatRoutes = (summary: unknown, detail: unknown): readonly PreviewRoute[] => [
  { path: MY_FLOATS, data: summary },
  { path: FLOAT_DETAIL, data: detail },
];

function MyPettyCash(): JSX.Element {
  const { state } = previewSession("employee");
  if (state.status !== "ready") throw new Error("preview session");
  return <MyPettyCashScreen company={state.company} layout="tab" />;
}

export const PAYROLL_AREA: PreviewArea = {
  routes: [],
  screens: [
    {
      key: "payroll",
      name: "Payroll",
      role: "admin",
      tab: "payroll",
      routes: payrollRoutes(RUN_LIST, SALARY_LIST),
      render: Payroll,
    },
    {
      key: "payroll-no-run",
      name: "Payroll · no upcoming run",
      role: "admin",
      tab: "payroll",
      routes: payrollRoutes(RUN_LIST.slice(1), SALARY_LIST),
      render: Payroll,
    },
    {
      key: "payroll-empty",
      name: "Payroll · no salaries",
      role: "admin",
      tab: "payroll",
      routes: payrollRoutes([], []),
      render: Payroll,
    },
    {
      key: "payroll-loading",
      name: "Payroll · loading",
      role: "admin",
      tab: "payroll",
      routes: payrollRoutes(PREVIEW_PENDING, PREVIEW_PENDING),
      render: Payroll,
    },
    {
      key: "payroll-error",
      name: "Payroll · error",
      role: "admin",
      tab: "payroll",
      routes: payrollRoutes(PREVIEW_FAIL, PREVIEW_FAIL),
      render: Payroll,
    },
    {
      key: "pay",
      name: "Pay",
      role: "employee",
      tab: "me/pay",
      routes: [{ path: MY_PAYMENTS, data: PAYMENTS }],
      render: MyPay,
    },
    {
      key: "pay-empty",
      name: "Pay · no payments",
      role: "employee",
      tab: "me/pay",
      routes: [{ path: MY_PAYMENTS, data: [] }],
      render: MyPay,
    },
    {
      key: "petty-cash",
      name: "Petty cash",
      role: "employee",
      tab: "me/petty-cash",
      routes: floatRoutes({ floats: [floatSummary] }, floatDetail),
      render: MyPettyCash,
    },
    {
      key: "petty-cash-none",
      name: "Petty cash · no float",
      role: "employee",
      tab: "me/petty-cash",
      routes: floatRoutes({ floats: [] }, PREVIEW_FAIL),
      render: MyPettyCash,
    },
  ],
};
