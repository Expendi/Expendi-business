/** DEV PREVIEW — the Bills tab and the recurring list. */
import type { JSX } from "react";

import type { Bill, RecurringItem } from "@expendi-business/shared";

import type { PreviewArea, PreviewRoute, PreviewScreen } from "../types";
import { shiftIsoDate } from "~/features/bills/bill-groups";
import { BillsScreen } from "~/features/bills/bills-screen";
import { localIsoDate } from "~/features/claims/dates";
import { RecurringScreen } from "~/features/recurring/recurring-screen";
import { previewSession } from "../session";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "../types";

const OPEN = /\/bills\?status=overdue/;
const HISTORY = /\/bills\?status=paid/;
const RECURRING = /\/recurring-items$/;

const today = localIsoDate(new Date());
const inDays = (days: number): string => shiftIsoDate(today, days);

const CATEGORY = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Utilities",
};
const NOW = "2026-11-01T08:00:00.000Z";

let counter = 0;
const uuid = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

function payee(
  name: string,
  method: Bill["payee"]["method"] = "mpesa_paybill",
): Bill["payee"] {
  return { id: uuid(), name, kind: "supplier", method, archived: false };
}

function bill(overrides: Partial<Bill>): Bill {
  return {
    id: uuid(),
    paymentReceipts: [],
    status: "upcoming",
    payee: payee("Supplier"),
    overviewHeading: "transactions",
    category: CATEGORY,
    variable: false,
    currency: "kes",
    amountKes: "100000",
    amountUsdc: null,
    reference: null,
    notes: null,
    dueOn: inDays(10),
    recurringItemId: null,
    payrollRunId: null,
    adjustmentReason: null,
    paidOn: null,
    paidAt: null,
    markedPaidBy: null,
    paidOutsideNote: null,
    cancelledReason: null,
    cancelledAt: null,
    cancelledBy: null,
    payoutId: null,
    fileCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const OPEN_BILLS: Bill[] = [
  bill({
    status: "overdue",
    payee: payee("Safaricom Fibre"),
    amountKes: "899900",
    dueOn: inDays(-2),
  }),
  bill({
    status: "due",
    payee: payee("Office rent", "bank"),
    amountKes: "8500000",
    dueOn: today,
  }),
  bill({
    status: "upcoming",
    payee: payee("Zoho Books"),
    amountKes: "312000",
    dueOn: inDays(4),
    recurringItemId: uuid(),
  }),
  bill({
    status: "upcoming",
    payee: payee("Figma", "usdc"),
    currency: "usd",
    amountKes: null,
    amountUsdc: "45000000",
    dueOn: inDays(6),
  }),
  bill({
    status: "upcoming",
    payee: payee("KPLC postpaid"),
    variable: true,
    amountKes: null,
    dueOn: inDays(9),
  }),
  bill({
    status: "upcoming",
    payee: payee("AWS"),
    amountKes: "750000",
    dueOn: inDays(20),
    recurringItemId: uuid(),
  }),
  bill({
    status: "paying",
    payee: payee("Nairobi Water"),
    amountKes: "184000",
    dueOn: inDays(1),
  }),
];

const HISTORY_BILLS: Bill[] = [
  bill({
    status: "paid",
    payee: payee("Jambo Stationers"),
    amountKes: "245000",
    dueOn: inDays(-6),
    paidOn: inDays(-6),
  }),
  bill({
    status: "paid_outside",
    payee: payee("KRA PAYE", "bank"),
    amountKes: "3120000",
    dueOn: inDays(-12),
    paidOn: inDays(-11),
  }),
  bill({
    status: "cancelled",
    payee: payee("Duplicate invoice"),
    amountKes: "50000",
    dueOn: inDays(-20),
    cancelledAt: `${inDays(-19)}T10:00:00.000Z`,
  }),
];

const RECURRING_ITEMS: RecurringItem[] = [
  recurring("Office rent", "bank", "8500000", "monthly", 1, "active"),
  recurring("Zoho Books", "mpesa_paybill", "312000", "monthly", 15, "active"),
  recurring("KPLC postpaid", "mpesa_paybill", null, "monthly", 20, "paused"),
  recurring("Old hosting", "bank", "120000", "yearly", 1, "ended"),
];

function recurring(
  name: string,
  method: Bill["payee"]["method"],
  amountKes: string | null,
  schedule: RecurringItem["schedule"],
  scheduleDay: number,
  state: RecurringItem["state"],
): RecurringItem {
  const nextDueOn = state === "ended" ? null : inDays(scheduleDay % 28);
  return {
    id: uuid(),
    state,
    payee: payee(name, method),
    overviewHeading: "transactions",
    category: CATEGORY,
    variable: amountKes === null,
    currency: "kes",
    amountKes,
    amountUsdc: null,
    schedule,
    scheduleDay,
    startsOn: inDays(-90),
    endsOn: null,
    payVia: "expendi",
    reminderDays: 3,
    active: state === "active",
    nextDueOn,
    nextBill: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const routes = (open: unknown, history: unknown): readonly PreviewRoute[] => [
  { path: OPEN, data: open },
  { path: HISTORY, data: history },
];

function Bills(): JSX.Element {
  const { state } = previewSession("admin");
  if (state.status !== "ready") throw new Error("preview session");
  return <BillsScreen company={state.company} />;
}

function Recurring(): JSX.Element {
  const { state } = previewSession("admin");
  if (state.status !== "ready") throw new Error("preview session");
  return <RecurringScreen company={state.company} />;
}

function billsScreen(
  key: string,
  name: string,
  fixtures: readonly PreviewRoute[],
): PreviewScreen {
  return {
    key,
    name,
    role: "admin",
    tab: "bills",
    routes: fixtures,
    render: Bills,
  };
}

export const BILLS_AREA: PreviewArea = {
  routes: [],
  screens: [
    billsScreen("bills", "Bills · to pay", routes(OPEN_BILLS, HISTORY_BILLS)),
    billsScreen("bills-empty", "Bills · nothing to pay", routes([], [])),
    billsScreen(
      "bills-loading",
      "Bills · loading",
      routes(PREVIEW_PENDING, PREVIEW_PENDING),
    ),
    billsScreen(
      "bills-error",
      "Bills · error",
      routes(PREVIEW_FAIL, PREVIEW_FAIL),
    ),
    {
      key: "recurring",
      name: "Recurring payments",
      role: "admin",
      routes: [{ path: RECURRING, data: RECURRING_ITEMS }],
      render: Recurring,
    },
    {
      key: "recurring-empty",
      name: "Recurring · empty",
      role: "admin",
      routes: [{ path: RECURRING, data: [] }],
      render: Recurring,
    },
  ],
};
