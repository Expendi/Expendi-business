import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  Expense,
  ExpenseListQuery,
  ExpensesSummary,
} from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { ExpenseDetails } from "./expense-sheet";
import { EXPENSES_PAGE_SIZE, ExpensesView } from "./expenses-view";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams("kind=petty_cash&month=2026-10"),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/expenses",
  useRouter: () => ({ replace: vi.fn() }),
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

const totals = (count: number, totalKes = "0") => ({ count, totalKes });

const summary: ExpensesSummary = {
  ...totals(2, "9007199254770993"),
  waitingForApproval: totals(1, "9007199254740993"),
  withoutReceipt: totals(1, "9007199254740993"),
  withoutEtims: totals(0),
  kinds: { claim: 7, petty_cash: 2, company: 3 },
};

const ROWS = [
  expense({}),
  expense({
    id: id(5),
    kind: "claim",
    status: "submitted",
    merchant: "Quickmart",
    amountKes: "9007199254740993",
    receiptCount: 0,
    noReceipt: true,
    etimsStatus: "attached",
    warnings: [
      { code: "older_than_60_days", spentOn: "2026-06-01", ageDays: 136 },
    ],
  }),
];

const QUERY = { kind: "petty_cash", month: "2026-10" } as const;

const listKey = (query: ExpenseListQuery) =>
  queryKeys.expenseList(ORG, {
    ...query,
    sort: "date",
    dir: "desc",
    limit: EXPENSES_PAGE_SIZE,
  });

function render(
  role: "admin" | "accountant",
  seed: (client: QueryClient) => void = (client) => {
    client.setQueryData(queryKeys.expenseSummary(ORG, QUERY), summary);
    client.setQueryData(listKey(QUERY), {
      pages: [{ expenses: ROWS, nextCursor: "next" }],
      pageParams: [null],
    });
  },
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  queryClient.setQueryData(queryKeys.members(ORG), []);
  queryClient.setQueryData(queryKeys.categories(ORG), [
    { id: id(2), name: "Office supplies", etimsNotRequired: false },
  ]);
  seed(queryClient);
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

/** What a sighted reader sees: tags and screen-reader-only text removed. */
const visibleText = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("all expenses", () => {
  it("shows spreadsheet import only to company admins", () => {
    expect(render("admin")).toContain("/imports?kind=history");
    expect(render("accountant")).not.toContain("/imports?kind=history");
  });

  it.each(["admin", "accountant"] as const)(
    "shows a %s the kind tabs with counts, every filter chip and the stat cards",
    (role) => {
      // #when
      const text = visibleText(render(role));

      // #then
      expect({
        tabs: [
          "All 12",
          "Reimbursements 7",
          "Petty cash 2",
          "Company spending 3",
        ].every((tab) => text.includes(tab)),
        chips: [
          "Filter",
          "Person",
          "Category",
          "Month",
          "Status",
          "Receipt",
          "eTIMS",
        ].every((chip) => text.includes(chip)),
        stats: [
          "Total spent",
          "2 expenses · October 2026",
          "Waiting for approval",
          "Without a receipt",
          "Without eTIMS",
          "All clear",
        ].every((stat) => text.includes(stat)),
        noClaimWording: !/claim/i.test(text),
      }).toEqual({
        tabs: true,
        chips: true,
        stats: true,
        noClaimWording: true,
      });
    },
  );

  it("lists each expense on two lines with its markers and exact amount", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      rows: ["Naivas Supermarket", "Quickmart"].every((merchant) =>
        html.includes(merchant),
      ),
      meta: html.includes("Petty cash · Office supplies"),
      exactAmount: html.includes("90,071,992,547,409.93"),
      noReceipt: html.includes("No receipt"),
      old: html.includes("Over 60 days old"),
      noEtims: html.includes("No eTIMS"),
      status: html.includes("Waiting for approval"),
      newestFirst: html.includes('aria-sort="descending"'),
      loadMore: html.includes("Load more"),
      showing: visibleText(html).includes("Showing 2 of 2"),
    }).toEqual({
      rows: true,
      meta: true,
      exactAmount: true,
      noReceipt: true,
      old: true,
      noEtims: true,
      status: true,
      newestFirst: true,
      loadMore: true,
      showing: true,
    });
  });

  it("offers to clear the filters when none match", () => {
    // #given
    navigation.params = new URLSearchParams(
      "kind=petty_cash&month=2026-10&noReceipt=1",
    );
    const query = { ...QUERY, noReceipt: "true" } as const;

    // #when
    const html = render("admin", (client) => {
      client.setQueryData(queryKeys.expenseSummary(ORG, query), {
        ...summary,
        ...totals(0),
      });
      client.setQueryData(listKey(query), {
        pages: [{ expenses: [], nextCursor: null }],
        pageParams: [null],
      });
    });
    navigation.params = new URLSearchParams("kind=petty_cash&month=2026-10");

    // #then
    expect({
      empty: html.includes("No expenses match these filters"),
      clear: html.includes("Clear filters"),
      clearAll: html.includes("Clear all"),
      chipSet: html.includes("Receipt:"),
    }).toEqual({ empty: true, clear: true, clearAll: true, chipSet: true });
  });

  it("says when the list didn't load, with Try again", () => {
    // #when
    const html = render("admin", (client) => {
      client
        .getQueryCache()
        .build(client, { queryKey: listKey(QUERY) })
        .setState({
          status: "error",
          error: new Error("offline"),
          fetchStatus: "idle",
        });
    });

    // #then
    expect({
      error: visibleText(html).includes("Expenses didn't load"),
      retry: html.includes("Try again"),
      stats: html.includes("Total spent"),
    }).toEqual({ error: true, retry: true, stats: false });
  });
});

describe("an expense's side sheet", () => {
  it("shows warnings, the missing receipt and every detail in the app's words", () => {
    // #when
    const text = visibleText(
      renderToStaticMarkup(
        <ExpenseDetails
          expense={expense({
            kind: "claim",
            listKind: "claim",
            status: "paid",
            floatId: null,
            receiptCount: 0,
            noReceipt: true,
            noReceiptReason: "Matatus don't give receipts.",
            etimsStatus: "attached",
            etimsInvoiceNumber: "0040812345",
            etimsSupplierPin: "P051238822K",
            mpesaCode: "SK41H7QZ2P",
            paidAt: "2026-10-31T09:00:00.000Z",
            selfApproved: true,
            warnings: [
              {
                code: "near_duplicate",
                expenseId: id(9),
                spentOn: "2026-10-14",
                amountKes: "500000",
              },
            ],
          })}
          receipts={<p>receipts here</p>}
        />,
      ),
    );

    // #then
    expect(
      [
        "Check before approving",
        "The same person submitted KES 5,000 on 14 Oct 2026 too.",
        "No receipt: Matatus don't give receipts.",
        "Submitted by Jane Wanjiku",
        "Invoice 0040812345",
        "Supplier PIN P051238822K",
        "SK41H7QZ2P",
        "Paid 31 Oct 2026",
        "Approved by the person who submitted it",
        "receipts here",
      ].filter((line) => !text.includes(line)),
    ).toEqual([]);
  });

  it("names the float holder and who recorded company spending", () => {
    // #when
    const float = renderToStaticMarkup(
      <ExpenseDetails expense={expense({})} receipts={null} />,
    );
    const company = renderToStaticMarkup(
      <ExpenseDetails
        expense={expense({
          kind: "company",
          listKind: "company",
          floatId: null,
          paidFromAccount: { id: id(8), name: "KCB current account" },
          source: "import",
        })}
        receipts={null}
      />,
    );

    // #then
    expect({
      holder: float.includes("Float holder"),
      recorded: company.includes("Recorded by"),
      paidFrom: company.includes("KCB current account"),
      imported: company.includes("Imported history"),
    }).toEqual({
      holder: true,
      recorded: true,
      paidFrom: true,
      imported: true,
    });
  });
});
