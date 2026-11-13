import type { QueryKey } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExportSummary,
  GeneratedExport,
  ReportFormat,
  ReportMonthSummary,
} from "@expendi-business/shared";

import {
  REPORT_SPENDING_6,
  REPORT_SUMMARY,
  SHARED_EXPORTS,
} from "~/app/dev/preview/_harness/fixtures/reports";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { billKeys } from "~/features/payment-keys";
import { ApiError } from "~/lib/api";
import { FileContents } from "./file-sheet";
import { nairobiMonth, shareMessage } from "./report-month";
import {
  fetchBillPaymentReceipt,
  fetchReportFile,
  reportKeys,
} from "./reports-api";
import {
  categoryRows,
  changeLine,
  deltaText,
  DOWNLOADS,
  etimsSub,
  KIND_LABELS,
  outstandingSub,
  receiptsSub,
  resolveMonth,
  sortCategories,
  sortExports,
} from "./reports-display";
import { ReportsView } from "./reports-view";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/reports",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => navigation.params,
}));
vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ getAccessToken: () => Promise.resolve("token") }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const API = {
  baseUrl: "https://api.example.com/",
  getAccessToken: () => Promise.resolve("accountant-token"),
};

/** 09:00 on 6 November 2026 in Nairobi, as in the mocks. */
const SIXTH_OF_NOVEMBER = new Date("2026-11-06T06:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SIXTH_OF_NOVEMBER);
  navigation.params = new URLSearchParams();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Seed = "data" | "loading" | "error";

function failed(client: QueryClient, queryKey: QueryKey): void {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiError(500, "Internal", "The API failed"),
    });
}

function render(
  role: "admin" | "accountant",
  {
    summary = "data",
    spending = "data",
    exports = SHARED_EXPORTS,
  }: {
    summary?: Seed;
    spending?: Seed;
    exports?: readonly ExportSummary[] | "error";
  } = {},
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  const summaryKey = reportKeys.summary(ORG, "2026-10");
  const spendingKey = reportKeys.spending(ORG, "2026-10", 6);
  if (summary === "data") client.setQueryData(summaryKey, REPORT_SUMMARY);
  if (summary === "error") failed(client, summaryKey);
  if (spending === "data") client.setQueryData(spendingKey, REPORT_SPENDING_6);
  if (spending === "error") failed(client, spendingKey);
  if (exports === "error") failed(client, reportKeys.exports(ORG));
  else client.setQueryData(reportKeys.exports(ORG), exports);
  client.setQueryData(billKeys.kesRate(ORG), {
    status: "active",
    address: "0x8f3a5b2c9d1e4f7a6b0c3d2e1f9a8b7c6d5e4c21",
    chain: "base",
    usdcBalance: "16420800000",
    kesEquivalent: { kesCents: "211828320", rate: "129" },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Mwangaza Logistics", role }}
      >
        <ReportsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the reports page", () => {
  it("opens on the month just ended in Nairobi", () => {
    // #when
    const html = text(render("accountant"));

    // #then
    expect(html).toContain("Month: October 2026");
    expect(html).toContain(
      "October 2026. Each file is made from today's records when you download it.",
    );
  });

  it("sums up the month's export in four plain cards", () => {
    // #when
    const html = text(render("admin"));

    // #then
    expect({
      moneyOut: html.includes(
        "Money out KES 1,920,000 92 payments · Up 4% on September",
      ),
      outstanding: html.includes("Outstanding bills KES 32,000 1 bill"),
      receipts: html.includes("Receipts 65 6 expenses have none"),
      etims: html.includes(
        "With an eTIMS invoice 38 of 66 18 without one · 10 not required",
      ),
    }).toEqual({
      moneyOut: true,
      outstanding: true,
      receipts: true,
      etims: true,
    });
  });

  it("lists the four downloads with their file names and what's in them", () => {
    // #when
    const html = render("accountant");
    const plain = text(html);

    // #then
    expect({
      titles: DOWNLOADS.map(({ title }) =>
        html.includes(`Download<span class="sr-only"> ${title}</span>`),
      ),
      files: [
        "expendi-2026-10.xlsx",
        "expendi-2026-10-csv.zip",
        "expendi-2026-10-receipts.zip",
        "expendi-2026-10-etims.csv",
      ].map((name) => plain.includes(name)),
      facts: [
        "3 sheets",
        "3 files",
        "92 payments",
        "65 receipts",
        "66 expenses",
      ].map((fact) => plain.includes(fact)),
      inside: plain.split("What's inside").length - 1,
    }).toEqual({
      titles: [true, true, true, true],
      files: [true, true, true, true],
      facts: [true, true, true, true, true],
      inside: 4,
    });
  });

  it("offers an admin links to share, and tells an accountant about the monthly email", () => {
    // #when
    const admin = text(render("admin"));
    const accountant = text(render("accountant"));

    // #then
    expect({
      admin: [
        admin.includes("Make links to share"),
        admin.includes("You also get last month's export by email"),
      ],
      accountant: [
        accountant.includes("Make links to share"),
        accountant.includes("You also get last month's export by email"),
      ],
    }).toEqual({ admin: [true, false], accountant: [false, true] });
  });

  it("charts money out by month and heading, and lists each category against the month before", () => {
    // #when
    const html = text(render("admin"));

    // #then
    expect({
      cards: ["Money out by month", "By heading", "By category"].map((title) =>
        html.includes(title),
      ),
      range: html.includes("Show: Last 6 months"),
      headings: [
        "Petty cash",
        "Transactions",
        "Salaries & personnel",
        "Subscriptions",
      ].map((heading) => html.includes(heading)),
      fuel: html.includes(
        "Fuel & transport Transactions and Petty cash · 30 payments",
      ),
      change: html.includes("KES 124,000 KES 162,000 +31%"),
    }).toEqual({
      cards: [true, true, true],
      range: true,
      headings: [true, true, true, true],
      fuel: true,
      change: true,
    });
  });

  it("lists the exports made with links, newest first", () => {
    // #when
    const html = text(render("accountant"));

    // #then
    expect({
      first:
        html.indexOf("October 2026 export") <
        html.indexOf("September 2026 export"),
      monthly: html.includes(
        "October 2026 export Monthly email to accountants",
      ),
      shared: html.includes("Shared by Wanjiru Kamau"),
      working: html.includes("Links work"),
      expired: html.includes("Links expired"),
      count: html.includes("7 exports"),
    }).toEqual({
      first: true,
      monthly: true,
      shared: true,
      working: true,
      expired: true,
      count: true,
    });
  });

  it("says what to do when nothing has been shared yet", () => {
    // #when
    const admin = text(render("admin", { exports: [] }));
    const accountant = text(render("accountant", { exports: [] }));

    // #then
    expect([
      admin.includes("To send one now, make links to share."),
      accountant.includes(
        "Your first monthly export arrives by email on the 1st.",
      ),
    ]).toEqual([true, true]);
  });

  it("shows each part that didn't load with Try again", () => {
    // #when
    const html = text(
      render("admin", {
        summary: "error",
        spending: "error",
        exports: "error",
      }),
    );

    // #then
    expect({
      summary: html.includes("The month's figures didn't load"),
      spending: html.includes("Spending didn't load"),
      exports: html.includes("Shared exports didn't load"),
      retry: html.split("Try again").length - 1,
    }).toEqual({ summary: true, spending: true, exports: true, retry: 3 });
  });

  it("shows skeletons while the month loads", () => {
    // #when
    const html = render("admin", { summary: "loading", spending: "loading" });

    // #then
    expect([
      html.includes('aria-busy="true"'),
      text(html).includes("What's inside"),
    ]).toEqual([true, false]);
  });
});

describe("what's inside a download", () => {
  it("names the workbook's sheets and shows the money out rows, reimbursements included", () => {
    // #when
    const html = text(
      renderToStaticMarkup(
        <FileContents
          format="workbook"
          summary={REPORT_SUMMARY}
          partial={false}
        />,
      ),
    );

    // #then
    expect({
      sheets: [
        "Sheet 1: Money out · 92 rows",
        "Sheet 2: Outstanding bills · 1 row",
        "Sheet 3: Float transfers · 2 rows",
      ].map((label) => html.includes(label)),
      reimbursement: html.includes("Reimbursement Brian Otieno 5,180"),
      more: html.includes("And 87 more rows."),
      noClaims: /\bclaims?\b/i.test(html),
    }).toEqual({
      sheets: [true, true, true],
      reimbursement: true,
      more: true,
      noClaims: false,
    });
  });

  it("warns about expenses without a receipt", () => {
    // #when
    const html = text(
      renderToStaticMarkup(
        <FileContents
          format="receipts"
          summary={REPORT_SUMMARY}
          partial={false}
        />,
      ),
    );

    // #then
    expect([
      html.includes("65 files"),
      html.includes("6 expenses have no receipt"),
    ]).toEqual([true, true]);
  });
});

describe("report wording", () => {
  const context = {
    month: "2026-10",
    thisMonth: "2026-11",
    today: "2026-11-06",
  };

  it("compares a month with the one before", () => {
    // #then
    expect([
      changeLine(1_920_000, 1_838_000, context),
      changeLine(900, 1000, context),
      changeLine(1000, 1000, context),
      changeLine(1000, 0, context),
      changeLine(0, 0, context),
      changeLine(1000, 900, { ...context, month: "2026-11" }),
    ]).toEqual([
      "Up 4% on September",
      "Down 10% on September",
      "Same as September",
      "Nothing in September",
      "Nothing in September either",
      "So far, to 6 Nov",
    ]);
  });

  it("writes a table's change column", () => {
    // #then
    expect([
      deltaText(162, 124),
      deltaText(90, 100),
      deltaText(5, 5),
      deltaText(5, 0),
      deltaText(0, 0),
    ]).toEqual(["+31%", "−10%", "Same", "New", "None"]);
  });

  it("calls a claim a reimbursement", () => {
    // #then
    expect(KIND_LABELS.claim).toBe("Reimbursement");
  });

  it("words the outstanding, receipts and eTIMS cards", () => {
    // #given
    const summary: ReportMonthSummary = {
      ...REPORT_SUMMARY,
      outstanding: {
        ...REPORT_SUMMARY.outstanding,
        rows: 3,
        overdue: 2,
        withoutAmount: 1,
      },
      receipts: { ...REPORT_SUMMARY.receipts, files: 4, expensesWithout: 0 },
      etims: { ...REPORT_SUMMARY.etims, rows: 0 },
    };

    // #then
    expect([
      outstandingSub(summary),
      receiptsSub(summary),
      etimsSub(summary),
      outstandingSub({
        ...summary,
        outstanding: { ...summary.outstanding, rows: 0 },
      }),
    ]).toEqual([
      "3 bills · 2 overdue, 1 without an amount",
      "Every expense has one",
      "No expenses this month",
      "None due by month end",
    ]);
  });

  it("takes only a month up to this one from the URL", () => {
    // #then
    expect([
      resolveMonth("2026-09", "2026-11"),
      resolveMonth("2026-12", "2026-11"),
      resolveMonth("October", "2026-11"),
      resolveMonth(null, "2026-11"),
    ]).toEqual(["2026-09", null, null, null]);
  });

  it("sorts categories by the chosen month, largest first, and by change", () => {
    // #given
    const rows = categoryRows(REPORT_SPENDING_6);

    // #when
    const byMonth = sortCategories(rows, { key: "current", dir: "desc" });
    const byChange = sortCategories(rows, { key: "change", dir: "desc" });

    // #then
    expect([
      byMonth.slice(0, 3).map((row) => row.name),
      byChange[0]?.name,
    ]).toEqual([
      ["Salaries", "Suppliers", "Fuel & transport"],
      "Meals & entertainment",
    ]);
  });

  it("sorts shared exports by when they were made, newest first", () => {
    // #when
    const sorted = sortExports(SHARED_EXPORTS, { key: "made", dir: "desc" });

    // #then
    expect(sorted.map((exported) => exported.month)).toEqual([
      "2026-10",
      "2026-09",
      "2026-09",
      "2026-08",
      "2026-06",
      "2026-07",
      "2026-06",
    ]);
  });
});

describe("downloading a month's file", () => {
  it.each(["workbook", "csv", "receipts", "etims"] as const)(
    "gets the %s for the chosen month with the accountant's token and names it like the API",
    async (format: ReportFormat) => {
      // #given
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), {
            headers: { "content-type": "application/zip" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetcher);

      // #when
      const file = await fetchReportFile(API, ORG, "2026-10", format);

      // #then
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        filename: file.filename,
        bytes: [...new Uint8Array(await file.blob.arrayBuffer())],
      }).toEqual({
        url: `https://api.example.com/organizations/${ORG}/reports/2026-10/${format}`,
        authorization: "Bearer accountant-token",
        filename: {
          workbook: "expendi-2026-10.xlsx",
          csv: "expendi-2026-10-csv.zip",
          receipts: "expendi-2026-10-receipts.zip",
          etims: "expendi-2026-10-etims.csv",
        }[format],
        bytes: [0xef, 0xbb, 0xbf, 0x41],
      });
    },
  );

  it("raises the API's refusal with its message", async () => {
    // #given
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          {
            success: false,
            error: {
              _tag: "Forbidden",
              message: "Admins and accountants only",
            },
          },
          { status: 403 },
        ),
      ),
    );

    // #when
    const outcome = fetchReportFile(API, ORG, "2026-10", "etims");

    // #then
    await expect(outcome).rejects.toEqual(
      new ApiError(403, "Forbidden", "Admins and accountants only"),
    );
  });

  it("asks for a new sign-in instead of calling the API without a token", async () => {
    // #given
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    // #when
    const outcome = fetchReportFile(
      { ...API, getAccessToken: () => Promise.resolve(null) },
      ORG,
      "2026-10",
      "receipts",
    );

    // #then
    await expect(outcome).rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("downloading a bill's payment receipt", () => {
  const BILL = "22222222-2222-4222-8222-222222222222";

  it("gets the receipt with the session's token and names it as the API does", async () => {
    // #given
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          headers: {
            "content-type": "application/pdf",
            "content-disposition":
              'attachment; filename="payment-receipt-RCT-AB12CD34.pdf"',
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    // #when
    const file = await fetchBillPaymentReceipt(API, ORG, BILL);

    // #then
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      filename: file.filename,
      bytes: [...new Uint8Array(await file.blob.arrayBuffer())],
    }).toEqual({
      url: `https://api.example.com/organizations/${ORG}/bills/${BILL}/payment-receipt`,
      authorization: "Bearer accountant-token",
      filename: "payment-receipt-RCT-AB12CD34.pdf",
      bytes: [0x25, 0x50, 0x44, 0x46],
    });
  });

  it("raises the API's refusal when the bill has no receipt", async () => {
    // #given
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          {
            success: false,
            error: {
              _tag: "Conflict",
              message:
                "This bill wasn't paid through Expendi, so there's no payment receipt.",
            },
          },
          { status: 409 },
        ),
      ),
    );

    // #when
    const outcome = fetchBillPaymentReceipt(API, ORG, BILL);

    // #then
    await expect(outcome).rejects.toEqual(
      new ApiError(
        409,
        "Conflict",
        "This bill wasn't paid through Expendi, so there's no payment receipt.",
      ),
    );
  });
});

describe("report months", () => {
  it("takes the month from Nairobi's clock, not the browser's UTC date", () => {
    // #then
    expect([
      nairobiMonth(new Date("2026-10-31T20:59:59Z")),
      nairobiMonth(new Date("2026-10-31T21:00:00Z")),
    ]).toEqual(["2026-10", "2026-11"]);
  });

  it("writes the message an admin shares, as the app does", () => {
    // #given
    const exported: GeneratedExport = {
      id: "11111111-1111-4111-8111-111111111111",
      month: "2026-10",
      monthly: false,
      createdBy: "Jane Wanjiku",
      createdAt: "2026-11-02T07:00:00.000Z",
      expiresAt: "2026-12-02T07:00:00.000Z",
      links: {
        workbook: "https://api.expendi.app/downloads/reports/abc/workbook",
        csv: "https://api.expendi.app/downloads/reports/abc/csv",
        receipts: "https://api.expendi.app/downloads/reports/abc/receipts",
      },
    };

    // #when
    const message = shareMessage("Acme Ltd", exported);

    // #then
    expect(message).toBe(
      [
        "Acme Ltd: October 2026 export",
        "Spreadsheet (Excel): https://api.expendi.app/downloads/reports/abc/workbook",
        "Spreadsheet (CSV files): https://api.expendi.app/downloads/reports/abc/csv",
        "Receipts (zip): https://api.expendi.app/downloads/reports/abc/receipts",
        "These links work until 2 December 2026.",
      ].join("\n\n"),
    );
  });
});
