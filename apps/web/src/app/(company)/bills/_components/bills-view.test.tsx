import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bill, WalletResponse } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { billKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { BillsView } from "./bills-view";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const kesBill: Bill = {
  id: id(1),
  status: "overdue",
  payee: {
    id: id(50),
    name: "Kenya Power",
    kind: "supplier",
    method: "mpesa_paybill",
    archived: false,
  },
  overviewHeading: "transactions",
  category: { id: id(60), name: "Utilities" },
  variable: false,
  currency: "kes",
  amountKes: "1250050",
  amountUsdc: null,
  reference: "INV-204",
  notes: null,
  dueOn: "2026-10-30",
  recurringItemId: id(70),
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
  fileCount: 1,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};

const usdBill: Bill = {
  ...kesBill,
  id: id(2),
  status: "upcoming",
  payee: {
    id: id(51),
    name: "Figma",
    kind: "vendor",
    method: "usdc",
    archived: false,
  },
  overviewHeading: "subscriptions",
  currency: "usd",
  amountKes: null,
  amountUsdc: "45000000",
  reference: null,
  dueOn: "2026-11-15",
  recurringItemId: null,
  fileCount: 0,
};

const wallet: WalletResponse = {
  status: "active",
  address: "0x1234567890abcdef1234567890abcdef12345678",
  chain: "base",
  usdcBalance: "500000000",
  kesEquivalent: { kesCents: "6434000", rate: "128.68" },
};

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(billKeys.list(ORG, "open"), [kesBill, usdBill]);
  queryClient.setQueryData(billKeys.kesRate(ORG), wallet);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <BillsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the bills page", () => {
  it("shows an admin the bills by status, a USD bill with its KES equivalent, and Pay all", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      overdue: html.includes(">Overdue<"),
      upcoming: html.includes(">Upcoming<"),
      kes: html.includes("KES 12,500.50"),
      usd: html.includes("USD 45.00"),
      usdInKes: html.includes("≈ KES 5,790.60 today"),
      reference: html.includes("INV-204 · Utilities · Recurring · 1 file"),
      checkboxes: (html.match(/type="checkbox"/g) ?? []).length,
      newBill: html.includes(">New bill<"),
      selectAll: html.includes("Select all payable"),
    }).toEqual({
      overdue: true,
      upcoming: true,
      kes: true,
      usd: true,
      usdInKes: true,
      reference: true,
      checkboxes: 2,
      newBill: true,
      selectAll: true,
    });
  });

  it("shows an accountant the same bills read-only", () => {
    // #when
    const html = render("accountant");
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)</g)].map(
      ([, label]) => label,
    );

    // #then
    expect({
      kes: html.includes("KES 12,500.50"),
      usdInKes: html.includes("≈ KES 5,790.60 today"),
      checkbox: html.includes('type="checkbox"'),
      buttons,
    }).toEqual({
      kes: true,
      usdInKes: true,
      checkbox: false,
      buttons: ["To pay", "Paid &amp; cancelled", "Kenya Power", "Figma"],
    });
  });
});
