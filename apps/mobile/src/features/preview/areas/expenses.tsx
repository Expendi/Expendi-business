/** DEV PREVIEW — the Expenses tab, its months and the company spending list. */
import type { JSX } from "react";

import type { PreviewArea, PreviewRoute } from "../types";
import { ExpensesScreen } from "~/features/spending/expenses-screen";
import CompanySpendingRoute from "~/app/(admin)/spending/index";
import { PREVIEW_OVERVIEW } from "../overview-fixture";
import { previewSession } from "../session";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "../types";

const OVERVIEW = /\/overview(\?|$)/;
const OVERVIEW_OCTOBER = /\/overview\?month=2026-10/;
const SPENDING = /\/company-spending(\?|$)/;

function Expenses({ initialMonth }: { initialMonth?: string }): JSX.Element {
  const { state } = previewSession("admin");
  if (state.status !== "ready") throw new Error("preview session");
  return <ExpensesScreen company={state.company} initialMonth={initialMonth} />;
}

const ExpensesNow = (): JSX.Element => <Expenses />;
const ExpensesInOctober = (): JSX.Element => <Expenses initialMonth="2026-10" />;

const OCTOBER: PreviewRoute = {
  path: OVERVIEW_OCTOBER,
  data: {
    ...PREVIEW_OVERVIEW,
    month: "2026-10",
    previousMonth: "2026-09",
    currentKes: "73508400",
    previousKes: "64120000",
    headings: PREVIEW_OVERVIEW.headings.map((heading) => ({
      ...heading,
      currentKes: heading.previousKes,
    })),
    recentPayments: PREVIEW_OVERVIEW.recentPayments.map((payment) => ({
      ...payment,
      date: payment.date.replace("2026-11", "2026-10"),
    })),
  },
};

const NOTHING_SPENT: PreviewRoute = {
  path: OVERVIEW,
  data: {
    ...PREVIEW_OVERVIEW,
    currentKes: "0",
    headings: PREVIEW_OVERVIEW.headings.map((heading) => ({ ...heading, currentKes: "0" })),
    categories: PREVIEW_OVERVIEW.categories.map((category) => ({ ...category, currentKes: "0" })),
    recentPayments: [],
    outstanding: { ...PREVIEW_OVERVIEW.outstanding, noReceipt: [] },
  },
};

const SPENDING_PAGE = {
  nextCursor: "next",
  spending: [
    {
      id: "66666666-6666-4666-8666-666666666601",
      status: "recorded",
      overviewHeading: "subscriptions",
      merchant: "Google Workspace",
      amountKes: "602000",
      spentOn: "2026-11-05",
      description: null,
      category: { id: "33333333-3333-4333-8333-333333333301", name: "Software" },
      paidFromAccount: { id: "11111111-1111-4111-8111-111111111101", name: "KCB current account", kind: "bank", archived: false },
      bill: null,
      mpesaCode: null,
      etimsInvoiceNumber: null,
      etimsSupplierPin: null,
      etimsQrPayload: null,
      etimsStatus: "none",
      noReceipt: false,
      noReceiptReason: null,
      warnings: [],
      receiptCount: 1,
      recordedBy: { membershipId: "77777777-7777-4777-8777-777777777701", name: "Wanjiru Kamau", email: "wanjiru@mawingulabs.co.ke" },
      createdAt: "2026-11-05T08:00:00.000Z",
      updatedAt: "2026-11-05T08:00:00.000Z",
    },
    {
      id: "66666666-6666-4666-8666-666666666602",
      status: "recorded",
      overviewHeading: "transactions",
      merchant: "Kenya Power",
      amountKes: "450000",
      spentOn: "2026-11-03",
      description: null,
      category: { id: "33333333-3333-4333-8333-333333333302", name: "Utilities" },
      paidFromAccount: null,
      bill: { id: "88888888-8888-4888-8888-888888888801", payee: { id: "99999999-9999-4999-8999-999999999901", name: "Kenya Power" }, reference: null, dueOn: "2026-11-03" },
      mpesaCode: null,
      etimsInvoiceNumber: null,
      etimsSupplierPin: null,
      etimsQrPayload: null,
      etimsStatus: "none",
      noReceipt: true,
      noReceiptReason: "Bank charge",
      warnings: [{ code: "near_duplicate", expenseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01", amountKes: "450000", spentOn: "2026-11-02" }],
      receiptCount: 0,
      recordedBy: { membershipId: "77777777-7777-4777-8777-777777777701", name: "Wanjiru Kamau", email: "wanjiru@mawingulabs.co.ke" },
      createdAt: "2026-11-03T08:00:00.000Z",
      updatedAt: "2026-11-03T08:00:00.000Z",
    },
  ],
};

function Spending(): JSX.Element {
  return <CompanySpendingRoute />;
}

export const EXPENSES_AREA: PreviewArea = {
  routes: [],
  screens: [
    { key: "expenses", name: "Expenses", role: "admin", tab: "expenses", routes: [OCTOBER], render: ExpensesNow },
    { key: "expenses-october", name: "Expenses · past month", role: "admin", tab: "expenses", routes: [OCTOBER], render: ExpensesInOctober },
    { key: "expenses-none", name: "Expenses · nothing spent", role: "admin", tab: "expenses", routes: [NOTHING_SPENT], render: ExpensesNow },
    { key: "expenses-loading", name: "Expenses · loading", role: "admin", tab: "expenses", routes: [{ path: OVERVIEW, data: PREVIEW_PENDING }], render: ExpensesNow },
    { key: "expenses-error", name: "Expenses · error", role: "admin", tab: "expenses", routes: [{ path: OVERVIEW, data: PREVIEW_FAIL }], render: ExpensesNow },
    { key: "company-spending", name: "Company spending", role: "admin", routes: [{ path: SPENDING, data: SPENDING_PAGE }], render: Spending },
    { key: "company-spending-empty", name: "Company spending · empty", role: "admin", routes: [{ path: SPENDING, data: { spending: [], nextCursor: null } }], render: Spending },
    { key: "company-spending-error", name: "Company spending · error", role: "admin", routes: [{ path: SPENDING, data: PREVIEW_FAIL }], render: Spending },
  ],
};
