import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse, SpendingOverview } from "@expendi-business/shared";

import {
  OPEN_FLOATS,
  OVERVIEW,
  SPENDING_TREND,
} from "~/app/dev/preview/_harness/fixtures/overview";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { ApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { overviewKeys } from "./overview-api";
import { defaultOverviewMonth, OverviewView } from "./overview-view";

vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "privy-user" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
/** 09:00 on 6 November 2026 in Nairobi. */
const NOW = new Date("2026-11-06T06:00:00Z");

const ME: MeResponse = {
  user: {
    id: "00000000-0000-4000-8000-0000000000b1",
    email: "wanjiru@mwangaza.co.ke",
    phone: null,
    fullName: "Wanjiru Kamau",
  },
  memberships: [],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type Seed = (client: QueryClient) => void;

function client({
  overview = OVERVIEW,
  trend = true,
  extra,
}: {
  overview?: SpendingOverview | null;
  trend?: boolean;
  extra?: Seed;
} = {}): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  const month = defaultOverviewMonth(NOW);
  if (overview) {
    queryClient.setQueryData(overviewKeys.month(ORG, month), overview);
  }
  if (trend) {
    queryClient.setQueryData(overviewKeys.trend(ORG, month), SPENDING_TREND);
  }
  queryClient.setQueryData(overviewKeys.openFloats(ORG), OPEN_FLOATS);
  queryClient.setQueryData(queryKeys.me("privy-user"), ME);
  extra?.(queryClient);
  return queryClient;
}

function render(
  role: "admin" | "accountant" = "admin",
  queryClient: QueryClient = client(),
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
      >
        <OverviewView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

function failed(key: readonly unknown[], message: string): Seed {
  return (queryClient) => {
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: key })
      .setState({
        status: "error",
        fetchStatus: "idle",
        error: new ApiError(500, "Internal", message),
      });
  };
}

describe("OverviewView", () => {
  it("opens on last month, the latest complete one", () => {
    expect(defaultOverviewMonth(NOW)).toBe("2026-10");
  });

  it("greets the admin and counts what needs them", () => {
    const html = render();
    expect(html).toContain("Good morning, Wanjiru");
    expect(html).toContain("6 things need you");
    expect(html).toMatch(/Payments<span[^>]*>2</);
    expect(html).toMatch(/Approvals<span[^>]*>2</);
    expect(html).toMatch(/Missing documents<span[^>]*>2</);
  });

  it("gives each due bill its next step on the Bills page", () => {
    const html = render();
    const [rent] = OVERVIEW.outstanding.overdue;
    expect(html).toContain("Kilimani Properties");
    expect(html).toContain("Office rent for November, due 1 Nov");
    expect(html).toContain("Overdue 5 days");
    expect(html).toContain("Due today");
    expect(html).toMatch(
      new RegExp(`href="/bills\\?billId=${rent?.id ?? ""}">Pay</a>`),
    );
    expect(html).toContain("View bill");
  });

  it("sends reimbursements to Approvals and missing documents to Expenses", () => {
    const html = render();
    const [lunch] = OVERVIEW.outstanding.claims;
    const [fuel] = OVERVIEW.outstanding.noReceipt;
    expect(html).toContain(
      "Client lunch at Java House on 4 Nov · Meals &amp; entertainment",
    );
    expect(html).toContain(`/approvals?claimId=${lunch?.id ?? ""}`);
    expect(html).toContain("Review");
    expect(html).toContain(`/expenses?expenseId=${fuel?.id ?? ""}`);
    expect(html).toContain("No receipt");
    expect(html).toContain("No eTIMS invoice");
    expect(html).toContain("Kevin adds the receipt in the Expendi app.");
    expect(html).not.toMatch(/>[^<]*\bclaims?\b/i);
  });

  it("shows the wallet against the next 30 days", () => {
    const html = render();
    expect(html).toContain("USDC wallet");
    expect(html).toContain("16,420");
    expect(html).toContain(".80");
    expect(html).toContain("2,118,283.20");
    expect(html).toContain("Payments in progress");
    expect(html).toContain("224,760");
    expect(html).toContain("Due through 6 Dec");
    expect(html).toContain("1,860,000");
    expect(html).toContain("Left over");
    expect(html).toContain("33,523.20");
    expect(html).toContain("Covered for the next 30 days");
    expect(html).toContain("Rate today: KES 129 per USDC.");
    expect(html).toContain('href="/wallet"');
    expect(html).toContain("Pay someone");
  });

  it("says when the wallet is short", () => {
    const html = render(
      "admin",
      client({
        overview: {
          ...OVERVIEW,
          cash: { ...OVERVIEW.cash, status: "short", shortKes: "1200000" },
        },
      }),
    );
    expect(html).toContain("Short by");
    expect(html).toContain("Short by KES 12,000 in the next 30 days");
  });

  it("lists floats lowest first and what's coming up, each linked", () => {
    const html = render();
    const floats = html.slice(html.indexOf("Petty cash floats"));
    expect(floats.indexOf("Grace Achieng")).toBeLessThan(
      floats.indexOf("Kevin Mwangi"),
    );
    expect(html).toContain("Low");
    expect(html).toContain("of 15,000");
    expect(html).toContain("View all 11");
    expect(html).toContain("PAYE for October");
    expect(html).toContain("Water bill, monthly");
    expect(html).toContain("14 people");
    const payroll = OVERVIEW.cash.obligations.find(
      (row) => row.kind === "payroll",
    );
    expect(html).toContain(`/payroll?runId=${payroll?.id ?? ""}`);
  });

  it("charts how last month went", () => {
    const html = render();
    expect(html).toContain("How October went");
    expect(html).toContain("Spending outside payroll is up 14% on September.");
    expect(html).toContain("1.92M");
    expect(html).toContain("680K");
    expect(html).toContain(
      "Fuel &amp; transport drove 46% of the increase outside payroll.",
    );
    expect(html).toContain("Fuel &amp; transport +31%");
    expect(html).toContain("Bidco Kenya");
    expect(html).not.toContain(">Wanjiru Kamau<");
    expect(html).toContain("Export October");
    expect(html).toContain('href="/reports?month=2026-10"');
    expect(html).toContain("Show as table");
    expect(html).toContain('<th scope="row">October 2026</th>');
  });

  it("keeps the overview when the charts' data didn't load", () => {
    const month = defaultOverviewMonth(NOW);
    const html = render(
      "admin",
      client({
        trend: false,
        extra: failed(overviewKeys.trend(ORG, month), "Down"),
      }),
    );
    expect(html).toContain("6 things need you");
    expect(html).toContain("This chart didn&#x27;t load.");
    expect(html).toContain("By heading");
  });

  it("shows accountants everything with View in place of actions", () => {
    const html = render("accountant");
    expect(html).toContain("6 things are waiting");
    expect(html).not.toContain(">Pay</a>");
    expect(html).not.toContain("Pay someone");
    expect(html).not.toContain("Review");
    expect(html).toContain("View bill");
    expect(html).toContain("View reimbursement");
    expect(html).toContain("View expense");
  });

  it("says when nothing needs anyone, and what's paid next", () => {
    const html = render(
      "admin",
      client({
        overview: {
          ...OVERVIEW,
          outstanding: {
            overdue: [],
            dueToday: [],
            claims: [],
            noReceipt: [],
            noEtims: [],
          },
        },
      }),
    );
    expect(html).toContain("You&#x27;re all caught up");
    expect(html).toContain("Nothing needs you right now.");
    expect(html).toContain("Next payment: KRA,");
    expect(html).toContain("212,400");
    expect(html).toContain("9 Nov");
  });

  it("offers to try again when the overview didn't load", () => {
    const month = defaultOverviewMonth(NOW);
    const html = render(
      "admin",
      client({
        overview: null,
        extra: failed(
          overviewKeys.month(ORG, month),
          "Couldn't reach Expendi Business.",
        ),
      }),
    );
    expect(html).toContain("The overview didn&#x27;t load");
    expect(html).toContain("Couldn&#x27;t reach Expendi Business.");
    expect(html).toContain("Try again");
  });

  it("shows a skeleton while loading", () => {
    const html = render("admin", client({ overview: null }));
    expect(html).toContain('aria-label="Loading the overview"');
  });
});
