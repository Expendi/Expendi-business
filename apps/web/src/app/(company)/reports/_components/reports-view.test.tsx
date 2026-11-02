import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeneratedExport, ReportFormat } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { ApiError } from "~/lib/api";
import { nairobiMonth, shareMessage } from "./report-month";
import { fetchReportFile } from "./reports-api";
import { DOWNLOADS, ReportsView } from "./reports-view";

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ getAccessToken: () => Promise.resolve("token") }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const API = {
  baseUrl: "https://api.example.com/",
  getAccessToken: () => Promise.resolve("accountant-token"),
};

/** 00:30 on 1 November in Nairobi, still 31 October in UTC. */
const FIRST_OF_NOVEMBER_IN_NAIROBI = new Date("2026-10-31T21:30:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIRST_OF_NOVEMBER_IN_NAIROBI);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(role: "admin" | "accountant"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <ReportsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the reports page", () => {
  it("offers an accountant the export, CSV files, receipts and eTIMS report for the month just ended in Nairobi", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      month: [html.includes('max="2026-11"'), html.includes('value="2026-10"')],
      downloads: DOWNLOADS.map(({ title }) =>
        html.includes(`Download<span class="sr-only"> ${title}</span>`),
      ),
    }).toEqual({
      month: [true, true],
      downloads: [true, true, true, true],
    });
  });

  it("doesn't offer an accountant links to share", () => {
    // #when
    const html = render("accountant");

    // #then
    expect(html).not.toContain("Make links to share");
  });

  it("offers an admin the same downloads and links to share", () => {
    // #when
    const html = render("admin");

    // #then
    expect([
      DOWNLOADS.every(({ title }) => html.includes(title)),
      html.includes("Make links to share"),
    ]).toEqual([true, true]);
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
