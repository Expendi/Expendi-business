import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ActivityPage } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { ActivityView } from "./activity-view";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const page: ActivityPage = {
  entries: [
    {
      id: id(1),
      occurredAt: "2026-11-01T21:30:00.000000Z",
      actor: { type: "user", name: "Wanjiru Kamau" },
      action: "category.updated",
      entity: { type: "category", id: id(2) },
      before: { name: "Flights", etimsNotRequired: false },
      after: { name: "Air tickets", etimsNotRequired: true },
    },
    {
      id: id(3),
      occurredAt: "2026-11-01T08:00:00.000000Z",
      actor: { type: "system", name: null },
      action: "payout.paid",
      entity: { type: "payout", id: id(4) },
      before: null,
      after: { status: "paid" },
    },
  ],
  nextCursor: "next-page",
};

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["activity", ORG, {}], {
    pages: [page],
    pageParams: [null],
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
  it("shows who changed what and when, in Nairobi time, and pages on", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      when: html.includes("2 Nov 2026, 00:30"),
      who: html.includes("Wanjiru Kamau"),
      what: html.includes("Category updated"),
      change: html.includes("Name: Flights → Air tickets"),
      system: html.includes("Expendi (automatic)"),
      more: html.includes("Load more"),
    }).toEqual({
      when: true,
      who: true,
      what: true,
      change: true,
      system: true,
      more: true,
    });
  });

  it("reads the same for an admin and an accountant", () => {
    // #when
    const [asAdmin, asAccountant] = [render("admin"), render("accountant")];

    // #then
    expect(asAccountant).toBe(asAdmin);
  });
});
