import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CashObligation,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
  obligationAmount,
  overviewKes,
} from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { createApiClient } from "~/lib/api";
import { createCustomerApi } from "~/lib/customer-api";
import { formatUsdc } from "~/lib/money";
import { overviewKeys, OverviewView } from "./overview-view";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const obligation = (overrides: Partial<CashObligation>): CashObligation => ({
  id: id(10),
  kind: "bill",
  name: "Safaricom Fibre",
  dueOn: "2026-11-09",
  amountKes: "2000000",
  status: "upcoming",
  payVia: "expendi",
  needsAmount: false,
  heading: "subscriptions",
  ...overrides,
});

const overdueRent = obligation({
  id: id(11),
  name: "Landlord",
  dueOn: "2026-10-28",
  amountKes: "450000",
  status: "overdue",
  heading: "transactions",
});
const payrollToday = obligation({
  id: id(12),
  kind: "payroll",
  name: "November payroll",
  dueOn: "2026-11-02",
  amountKes: "6000000",
  status: "due",
  heading: "salaries",
});

/** One `GET /overview` answer with something in every part of the screen. */
const PAYLOAD: SpendingOverview = {
  month: "2026-11",
  previousMonth: "2026-10",
  // Larger than the headings below add up to, and than a float can hold.
  currentKes: "9007199254740993",
  previousKes: "12345",
  headings: [
    {
      id: "petty_cash",
      name: "Petty cash",
      currentKes: "250050",
      previousKes: "2345",
    },
    {
      id: "transactions",
      name: "Transactions",
      currentKes: "500000",
      previousKes: "10000",
    },
    {
      id: "salaries",
      name: "Salaries & personnel",
      currentKes: "0",
      previousKes: "0",
    },
    {
      id: "subscriptions",
      name: "Subscriptions",
      currentKes: "0",
      previousKes: "0",
    },
  ],
  categories: [
    { id: id(20), name: "Office", currentKes: "300000", previousKes: "10000" },
    { id: id(21), name: "Travel", currentKes: "450050", previousKes: "2345" },
  ],
  recentPayments: [
    {
      id: id(30),
      subjectId: id(31),
      kind: "bill",
      name: "Kenya Power",
      date: "2026-11-01",
      amountKes: "987654",
      heading: "transactions",
      categoryId: id(20),
      categoryName: "Office",
      personId: null,
      channel: "outside",
    },
    {
      id: id(32),
      subjectId: id(33),
      kind: "claim",
      name: "Java House",
      date: "2026-10-30",
      amountKes: "150050",
      heading: "transactions",
      categoryId: id(21),
      categoryName: "Travel",
      personId: id(40),
      channel: "expendi",
    },
  ],
  outstanding: {
    overdue: [overdueRent],
    dueToday: [payrollToday],
    claims: [
      { id: id(50), name: "Quickmart", amountKes: "123400", floatId: null },
    ],
    noReceipt: [
      { id: id(51), name: "Naivas", amountKes: "5600", floatId: id(52) },
    ],
  },
  cash: {
    today: "2026-11-02",
    through: "2026-12-02",
    totalKes: "8450000",
    unknownAmounts: 2,
    obligations: [
      overdueRent,
      payrollToday,
      obligation({}),
      obligation({
        id: id(13),
        name: "Office cleaners",
        amountKes: "300000",
        payVia: "outside",
        heading: "transactions",
      }),
      obligation({
        id: id(14),
        name: "Water bill",
        amountKes: null,
        needsAmount: true,
        heading: "transactions",
      }),
      obligation({
        id: id(15),
        kind: "forecast",
        name: "Amina",
        dueOn: "2026-11-28",
        amountKes: "6100000",
        status: "forecast",
        heading: "salaries",
      }),
      obligation({
        id: id(16),
        kind: "forecast",
        name: "Zoom",
        dueOn: "2026-11-30",
        amountKes: null,
        status: "forecast",
        heading: "subscriptions",
      }),
    ],
    balanceUsdc: "100000000",
    reservedUsdc: "2500000",
    balanceKes: "1286800",
    availableKes: "1254630",
    rate: "128.68",
    status: "short",
    shortKes: "7195370",
    outsideKes: "300000",
  },
  people: [{ id: id(40), name: "Amina Njeri" }],
};

const UNKNOWN_CASH: SpendingOverview = {
  ...PAYLOAD,
  cash: {
    ...PAYLOAD.cash,
    unknownAmounts: 1,
    balanceKes: null,
    availableKes: null,
    rate: null,
    status: "unknown",
    shortKes: null,
  },
};

function render(
  payload: SpendingOverview,
  role: "admin" | "accountant" = "admin",
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(overviewKeys.month(ORG, undefined), payload);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider company={{ organizationId: ORG, name: "Acme", role }}>
        <OverviewView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

/** What a person reads: the markup's text, entities decoded. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? "")
    .replace(/\s+/g, " ");

/**
 * Every figure the app's home screen shows for `payload`, worded by the
 * helpers `apps/mobile/src/features/overview/overview-display.ts` uses.
 */
function appFigures(payload: SpendingOverview): string[] {
  const { cash, outstanding } = payload;
  const outsideLine = cashOutsideLine(cash);
  return [
    cashHeadline(cash),
    cashFootnote(cash),
    ...(outsideLine === null ? [] : [outsideLine]),
    `${formatUsdc(cash.balanceUsdc)} USDC`,
    ...[cash.balanceKes, cash.availableKes, cash.totalKes].flatMap((value) =>
      value === null ? [] : [overviewKes(value)],
    ),
    overviewKes(payload.currentKes),
    overviewKes(payload.previousKes),
    ...[...payload.headings, ...payload.categories].flatMap((row) => [
      overviewKes(row.currentKes),
      overviewKes(row.previousKes),
    ]),
    ...[
      ...outstanding.overdue,
      ...outstanding.dueToday,
      ...cash.obligations,
    ].map(obligationAmount),
    ...[...outstanding.claims, ...outstanding.noReceipt].map((row) =>
      overviewKes(row.amountKes),
    ),
    ...payload.recentPayments.map((row) => overviewKes(row.amountKes)),
  ];
}

describe("the spending overview on the web", () => {
  it.each(["admin", "accountant"] as const)(
    "shows the %s every figure the app shows for the same answer, worded the same way",
    (role) => {
      // #when
      const text = textOf(render(PAYLOAD, role));

      // #then
      expect(
        appFigures(PAYLOAD).filter((figure) => !text.includes(figure)),
      ).toEqual([]);
    },
  );

  it("shows the API's month total rather than adding up the headings", () => {
    // #given
    const headingsSum = PAYLOAD.headings
      .reduce((sum, row) => sum + BigInt(row.currentKes), 0n)
      .toString();

    // #when
    const text = textOf(render(PAYLOAD));

    // #then
    expect([
      text.includes("KES 90,071,992,547,409.93"),
      text.includes(overviewKes(headingsSum)),
    ]).toEqual([true, false]);
  });

  it("says the cash check needs today's rate, and counts payments with no amount beside it", () => {
    // #when
    const text = textOf(render(UNKNOWN_CASH));

    // #then
    expect({
      headline: text.includes("Can't check without today's KES rate"),
      noAmount: text.includes("1 payment has no amount yet"),
      notCounted: text.includes("Not counting 1 payment with no amount yet."),
      outside: text.includes("bills paid outside Expendi aren't counted"),
      balance: text.includes("KES rate unavailable"),
    }).toEqual({
      headline: true,
      noAmount: true,
      notCounted: true,
      outside: true,
      balance: true,
    });
  });

  it("shows what's due outside Expendi under the cash check only when something is", () => {
    // #given
    const nothingOutside: SpendingOverview = {
      ...PAYLOAD,
      cash: { ...PAYLOAD.cash, outsideKes: "0" },
    };

    // #when
    const [something, nothing] = [PAYLOAD, nothingOutside].map((payload) =>
      textOf(render(payload)),
    );

    // #then
    expect([
      something?.includes("Also due outside Expendi: KES 3,000.00"),
      nothing?.includes("Also due outside Expendi"),
    ]).toEqual([true, false]);
  });

  it("never claims the 30-day total includes bills paid outside Expendi", () => {
    // #when
    const text = textOf(render(PAYLOAD));

    // #then
    expect(text).not.toMatch(/includes[^.]*paid outside/i);
  });

  it("gives an admin the app's actions on each payment due", () => {
    // #when
    const html = render(PAYLOAD, "admin");

    // #then
    expect(
      ["Pay", "Mark paid", "Enter amount", "View"].map((action) =>
        html.includes(`>${action}</a>`),
      ),
    ).toEqual([true, true, true, true]);
  });

  it("gives an accountant only View", () => {
    // #when
    const html = render(PAYLOAD, "accountant");

    // #then
    expect(
      ["Pay", "Mark paid", "Enter amount", "View"].map((action) =>
        html.includes(`>${action}</a>`),
      ),
    ).toEqual([false, false, false, true]);
  });

  it("opens a salary forecast on payroll and other forecasts on their schedule, by heading", () => {
    // #when
    const html = render(PAYLOAD);

    // #then
    expect([
      html.includes('href="/payroll"'),
      html.includes(`href="/recurring?itemId=${id(16)}"`),
      html.includes(`href="/recurring?itemId=${id(15)}"`),
    ]).toEqual([true, true, false]);
  });
});

describe("the overview's API contract", () => {
  const api = () =>
    createCustomerApi(
      createApiClient({
        baseUrl: "https://api.example.com",
        getAccessToken: () => Promise.resolve("token"),
      }),
    );

  it("reads the chosen month from the overview route the app uses", async () => {
    // #given
    const fetcher = vi.fn(() =>
      Promise.resolve(Response.json({ success: true, data: PAYLOAD })),
    );
    vi.stubGlobal("fetch", fetcher);

    // #when
    const overview = await api().getOverview(ORG, "2026-11");

    // #then
    expect([overview, fetcher.mock.calls[0]?.at(0)]).toEqual([
      PAYLOAD,
      `https://api.example.com/organizations/${ORG}/overview?month=2026-11`,
    ]);
  });

  it("refuses an answer whose payments due carry no heading", async () => {
    // #given
    const { heading: _heading, ...headless } = obligation({});
    const payload = {
      ...PAYLOAD,
      cash: { ...PAYLOAD.cash, obligations: [headless] },
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ success: true, data: payload })),
    );

    // #when
    const outcome = api().getOverview(ORG);

    // #then
    await expect(outcome).rejects.toMatchObject({ tag: "InvalidResponse" });
  });
});
