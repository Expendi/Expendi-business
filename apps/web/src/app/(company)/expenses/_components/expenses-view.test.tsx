import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Expense } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { ExpensesView } from "./expenses-view";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams("kind=petty_cash&month=2026-10"),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/expenses",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => navigation.params,
}));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const expense = (overrides: Partial<Expense>): Expense => ({
  id: id(1),
  kind: "float",
  listKind: "petty_cash",
  status: "recorded",
  source: "app",
  overviewHeading: "petty_cash",
  merchant: "Naivas Supermarket",
  amountKes: "30000",
  spentOn: "2026-10-15",
  description: "Printer paper",
  category: { id: id(2), name: "Office supplies" },
  member: { membershipId: id(3), name: "Jane Wanjiku", email: "j@e.com" },
  mpesaCode: null,
  etimsStatus: "none",
  etimsInvoiceNumber: null,
  etimsSupplierPin: null,
  warnings: [],
  receiptCount: 1,
  noReceipt: false,
  noReceiptReason: null,
  rejectedReason: null,
  selfApproved: false,
  approvedAt: null,
  paidAt: null,
  floatId: id(4),
  overspendClaimId: null,
  bill: null,
  paidFromAccount: null,
  createdAt: "2026-10-15T09:00:00.000Z",
  ...overrides,
});

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.members(ORG), []);
  queryClient.setQueryData(queryKeys.categories(ORG), [
    { id: id(2), name: "Office supplies", etimsNotRequired: false },
  ]);
  queryClient.setQueryData(
    queryKeys.expenseList(ORG, {
      membershipId: undefined,
      kind: "petty_cash",
      categoryId: undefined,
      month: "2026-10",
      etimsStatus: undefined,
      limit: 50,
    }),
    {
      pages: [
        {
          expenses: [
            expense({}),
            expense({
              id: id(5),
              kind: "claim",
              status: "submitted",
              merchant: "Quickmart",
              amountKes: "9007199254740993",
              overspendClaimId: null,
              receiptCount: 0,
              noReceipt: true,
            }),
          ],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <ExpensesView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("all expenses", () => {
  it("shows spreadsheet import only to company admins", () => {
    expect(render("admin")).toContain("/imports?kind=history");
    expect(render("accountant")).not.toContain("/imports?kind=history");
  });
  it.each(["admin", "accountant"] as const)(
    "shows a %s the filtered list, with every filter and exact amounts",
    (role) => {
      // #when
      const html = render(role);

      // #then
      expect({
        filters: ["Person", "Kind", "Category", "Month", "eTIMS"].every(
          (label) => html.includes(label),
        ),
        kindChosen: html.includes('<option value="petty_cash" selected=""'),
        rows: ["Naivas Supermarket", "Quickmart"].every((merchant) =>
          html.includes(merchant),
        ),
        exactAmount: html.includes("90,071,992,547,409.93"),
        noReceipt: html.includes("No receipt"),
      }).toEqual({
        filters: true,
        kindChosen: true,
        rows: true,
        exactAmount: true,
        noReceipt: true,
      });
    },
  );
});
