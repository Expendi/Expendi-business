import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ActivityPage } from "@expendi-business/shared";

import type { ActivityFilters } from "./activity-api";
import type * as DetailSheetModule from "~/components/data/detail-sheet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { activityKeys } from "./activity-api";
import { ActivityView } from "./activity-view";

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/activity",
  useSearchParams: () => search,
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/components/data/detail-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof DetailSheetModule>();
  return {
    ...actual,
    DetailSheet: ({
      open,
      eyebrow,
      title,
      headerExtra,
      footer,
      children,
    }: ComponentProps<typeof actual.DetailSheet>) =>
      open ? (
        <aside data-sheet="">
          <p>{eyebrow}</p>
          <h2>{title}</h2>
          {headerExtra}
          <div>{children}</div>
          <footer>{footer}</footer>
        </aside>
      ) : null,
  };
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const APPROVAL = id(50);
const WANJIRU = id(9);

const page: ActivityPage = {
  entries: [
    {
      id: id(1),
      occurredAt: "2026-11-01T21:30:00.000000Z",
      actor: { type: "user", id: WANJIRU, name: "Wanjiru Kamau" },
      action: "category.updated",
      entity: { type: "category", id: id(2), label: "Air tickets" },
      approvalId: null,
      before: { name: "Flights", etimsNotRequired: false },
      after: { name: "Air tickets", etimsNotRequired: true },
    },
    {
      id: id(3),
      occurredAt: "2026-11-01T08:00:00.000000Z",
      actor: { type: "system", id: null, name: null },
      action: "payout.paying",
      entity: { type: "payout", id: id(4), label: null },
      approvalId: null,
      before: { status: "funded" },
      after: { status: "paying", amountKes: "18600000" },
    },
    {
      id: id(5),
      occurredAt: "2026-11-01T06:00:00.000000Z",
      actor: { type: "user", id: WANJIRU, name: "Wanjiru Kamau" },
      action: "bill.payment_approved",
      entity: { type: "bill", id: id(6), label: "Jubilee Health, November" },
      approvalId: APPROVAL,
      before: { status: "due" },
      after: {
        status: "paying",
        approvalId: APPROVAL,
        currency: "kes",
        amountKes: "6450000",
        kesEquivalent: "6450000",
      },
    },
    {
      id: id(7),
      occurredAt: "2026-11-01T06:00:00.000000Z",
      actor: { type: "user", id: WANJIRU, name: "Wanjiru Kamau" },
      action: "bill.payment_approved",
      entity: { type: "bill", id: id(8), label: "Google Workspace, November" },
      approvalId: APPROVAL,
      before: { status: "due" },
      after: {
        status: "paying",
        approvalId: APPROVAL,
        currency: "usd",
        amountKes: null,
        amountUsdc: "72000000",
        kesEquivalent: "928800",
      },
    },
  ],
  nextCursor: "next-page",
};

function render({
  role = "accountant",
  query = "",
  filters = {},
  pages = [page],
}: {
  role?: "admin" | "accountant";
  query?: string;
  filters?: ActivityFilters;
  pages?: ActivityPage[];
} = {}): string {
  search = new URLSearchParams(query);
  const queryClient = new QueryClient();
  queryClient.setQueryData(activityKeys.list(ORG, filters), {
    pages,
    pageParams: pages.map((_, at) =>
      at === 0 ? null : `cursor-${String(at)}`,
    ),
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <ActivityView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the activity log", () => {
  it("shows who did what and when, in Nairobi time, one row per approval, and pages on", () => {
    // #when
    const html = render();

    // #then
    expect({
      day: html.includes("2 Nov 2026"),
      time: html.includes("00:30"),
      who: html.includes("Wanjiru Kamau"),
      what: html.includes("Category updated"),
      record: html.includes("Air tickets"),
      paymentSent: html.includes("Payment sent"),
      system: html.includes("Expendi (automatic)"),
      batch: html.includes("2 bills"),
      batchNames: html.includes("Jubilee Health and Google Workspace"),
      batchRows: html.split("Bill payment approved").length - 1,
      approximate: html.includes("≈"),
      more: html.includes("Load more"),
      showing: html.includes("Showing 3, newest first"),
    }).toEqual({
      day: true,
      time: true,
      who: true,
      what: true,
      record: true,
      paymentSent: true,
      system: true,
      batch: true,
      batchNames: true,
      batchRows: 2,
      approximate: true,
      more: true,
      showing: true,
    });
  });

  it("offers area, person, record and date filters", () => {
    // #when
    const html = render();

    // #then
    expect(
      ["Area", "Person", "Record", "Date"].map((chip) =>
        html.includes(`Filter by ${chip.toLowerCase()}`),
      ),
    ).toEqual([true, true, true, true]);
  });

  it("asks the API for one person's activity on one record from the URL", () => {
    // #when
    const html = render({
      query: `person=${WANJIRU}&record=category:${id(2)}&from=2026-11-01&to=2026-11-30`,
      filters: {
        actor: WANJIRU,
        entityType: "category",
        entityId: id(2),
        from: "2026-11-01",
        to: "2026-11-30",
      },
      pages: [{ entries: page.entries.slice(0, 1), nextCursor: null }],
    });

    // #then
    expect({
      row: html.includes("Category updated"),
      clearAll: html.includes("Clear all"),
      date: html.includes("Date: November 2026. Change"),
      all: html.includes("Showing all 1"),
    }).toEqual({ row: true, clearAll: true, date: true, all: true });
  });

  it("keeps looking while a filtered page comes back empty with more after it", () => {
    // #when
    const html = render({
      query: "person=system",
      filters: { actor: "system" },
      pages: [{ entries: [], nextCursor: "more" }],
    });

    // #then
    expect({
      loading: html.includes("Loading activity…"),
      empty: html.includes("Nothing matches these filters"),
    }).toEqual({ loading: true, empty: false });
  });

  it("says when nothing matches the filters", () => {
    // #when
    const html = render({
      query: "person=staff",
      filters: { actor: "staff" },
      pages: [{ entries: [], nextCursor: null }],
    });

    // #then
    expect(html).toContain("Nothing matches these filters");
  });

  it("opens an entry from the link with readable changes and where its record lives", () => {
    // #when
    const html = render({ query: `id=${id(1)}` });

    // #then
    expect({
      title: html.includes("<h2>Category updated</h2>"),
      changed: html.includes("What changed"),
      field: html.includes("eTIMS not required"),
      before: html.includes(">Flights<"),
      open: html.includes(
        `href="/settings?section=categories&amp;category=${id(2)}"`,
      ),
      openLabel: html.includes("Open in Settings"),
      allActivity: html.includes("All activity for this record"),
      readOnly: html.includes("Nothing here can be edited or deleted."),
      raw: html.includes("Recorded values"),
      position: html.includes("1 of 3"),
    }).toEqual({
      title: true,
      changed: true,
      field: true,
      before: true,
      open: true,
      openLabel: true,
      allActivity: true,
      readOnly: true,
      raw: true,
      position: true,
    });
  });

  it("opens a batch with each bill, its link and one total", () => {
    // #when
    const html = render({ query: `id=${id(7)}` });

    // #then
    expect({
      title: html.includes("<h2>Bill payment approved</h2>"),
      sub: html.includes("2 bills with one passkey approval"),
      passkey: html.includes(
        "Confirmed with Wanjiru Kamau&#x27;s approval passkey",
      ),
      together: html.includes("Bills paid"),
      links: html.split("Open in Bills").length - 1,
      billLink: html.includes(`href="/bills?billId=${id(8)}"`),
      usd: html.includes(">USD<"),
    }).toEqual({
      title: true,
      sub: true,
      passkey: true,
      together: true,
      links: 2,
      billLink: true,
      usd: true,
    });
  });

  it("reads the same for an admin and an accountant", () => {
    // #when
    const [asAdmin, asAccountant] = [
      render({ role: "admin" }),
      render({ role: "accountant" }),
    ];

    // #then
    expect(asAccountant).toBe(asAdmin);
  });

  it("points an admin and an accountant somewhere useful when there's no activity yet", () => {
    // #when
    const empty = [{ entries: [], nextCursor: null }];
    const [asAdmin, asAccountant] = [
      render({ role: "admin", pages: empty }),
      render({ role: "accountant", pages: empty }),
    ];

    // #then
    expect({
      title: asAdmin.includes("No activity yet"),
      admin: asAdmin.includes("Invite your team"),
      accountant: asAccountant.includes("Go to Overview"),
    }).toEqual({ title: true, admin: true, accountant: true });
  });
});
