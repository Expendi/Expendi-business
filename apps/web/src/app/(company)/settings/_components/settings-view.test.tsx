import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  CompanyZohoResponse,
  PaidFromAccount,
} from "@expendi-business/shared";

import type * as DetailSheetModule from "~/components/data/detail-sheet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { billKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { settingsKeys } from "./settings-api";
import { SettingsView } from "./settings-view";
import { describeSyncCounts } from "./zoho-settings";

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => search,
}));
vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
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
      footer,
      children,
    }: ComponentProps<typeof actual.DetailSheet>) =>
      open ? (
        <aside data-sheet="">
          <p>{eyebrow}</p>
          <h2>{title}</h2>
          <div>{children}</div>
          <footer>{footer}</footer>
        </aside>
      ) : null,
  };
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (
  n: number,
  name: string,
  kind: PaidFromAccount["kind"],
  archived = false,
): PaidFromAccount => ({
  id: id(n),
  name,
  kind,
  archived,
  createdAt: "2026-10-01T07:00:00.000Z",
  updatedAt: "2026-10-01T07:00:00.000Z",
});

const connected: CompanyZohoResponse = {
  status: "active",
  organizationName: "Acme Books Ltd",
  connectedAt: "2026-10-12T12:40:00.000Z",
  lastSyncedAt: "2026-11-06T06:20:00.000Z",
  counts: { pending: 3, synced: 212, failed: 1 },
  failed: [
    {
      id: id(30),
      subjectType: "bill",
      subjectId: id(31),
      label: "Twiga Foods",
      reason: "The expense account was deleted in Zoho Books.",
      failedAt: "2026-11-05T08:00:00.000Z",
    },
  ],
};

function render({
  role = "admin",
  query = "",
  enrolled = false,
  zoho = connected,
  categories = [
    { id: id(1), name: "Air travel", etimsNotRequired: true },
    { id: id(2), name: "Fuel", etimsNotRequired: false },
  ],
  categoriesFail = false,
}: {
  role?: "admin" | "accountant";
  query?: string;
  enrolled?: boolean;
  zoho?: CompanyZohoResponse;
  categories?: { id: string; name: string; etimsNotRequired: boolean }[];
  categoriesFail?: boolean;
} = {}): string {
  search = new URLSearchParams(query);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  queryClient.setQueryData(settingsKeys.company(ORG), {
    id: ORG,
    name: "Acme Ltd",
    kraPin: "P051234567X",
    role,
  });
  if (categoriesFail) {
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: queryKeys.categories(ORG) })
      .setState({ status: "error", error: new Error("Offline") });
  } else {
    queryClient.setQueryData(queryKeys.categories(ORG), categories);
  }
  queryClient.setQueryData(settingsKeys.archivedCategories(ORG), [
    { id: id(3), name: "Old marketing", etimsNotRequired: false },
  ]);
  queryClient.setQueryData(billKeys.paidFromAccounts(ORG), [
    account(10, "Equity Bank ••4521", "bank"),
    account(11, "Company M-Pesa till", "mobile_money"),
  ]);
  queryClient.setQueryData(settingsKeys.archivedPaidFromAccounts(ORG), [
    account(12, "Co-op Bank ••0932", "bank", true),
  ]);
  queryClient.setQueryData(settingsKeys.zoho(ORG), zoho);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-14T06:12:00.000Z" : null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <SettingsView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("settings", () => {
  it("lists the sections and the company's details", () => {
    // #when
    const html = render();

    // #then
    expect({
      sections: [
        "Company",
        "Approval passkey",
        "Categories",
        "Paid-from accounts",
        "Zoho Books",
      ].every(
        (section) =>
          html.includes(`data-section`) && html.includes(`>${section}<`),
      ),
      kraPin: html.includes("P051234567X"),
      role: html.includes("Your role"),
      locked: html.includes("They can&#x27;t be changed here."),
    }).toEqual({ sections: true, kraPin: true, role: true, locked: true });
  });

  it("lets an admin add and edit categories, and counts the archived ones", () => {
    // #when
    const html = render();

    // #then
    expect({
      inUse: html.includes("Air travel") && html.includes("Fuel"),
      exempt: html.includes("No invoice expected"),
      add: html.includes("Add category"),
      edit: html.includes('aria-label="Edit Air travel"'),
      archivedTab: html.includes(">Archived<"),
      archivedListed: html.includes("Old marketing"),
    }).toEqual({
      inUse: true,
      exempt: true,
      add: true,
      edit: true,
      archivedTab: true,
      archivedListed: false,
    });
  });

  it("opens a category's form from the link, with archiving a step away", () => {
    // #when
    const html = render({ query: `category=${id(2)}` });

    // #then
    expect({
      title: html.includes("<h2>Edit category</h2>"),
      name: html.includes('value="Fuel"'),
      save: html.includes(">Save<"),
      archive: html.includes(">Archive<"),
    }).toEqual({ title: true, name: true, save: true, archive: true });
  });

  it("asks an admin without a passkey to set one up, and flags it in the list", () => {
    // #when
    const html = render();

    // #then
    expect({
      status: html.includes("Not set up yet"),
      button: html.includes("Set up approval passkey"),
      flag: html.includes(", not set up yet"),
    }).toEqual({ status: true, button: true, flag: true });
  });

  it("shows a passkey that's set up, and how to replace it", () => {
    // #when
    const html = render({ enrolled: true });

    // #then
    expect({
      status: html.includes(">Set up<"),
      since: html.includes("14 Oct 2026, 09:12"),
      replace: html.includes("To replace it, contact Expendi."),
      button: html.includes("Set up approval passkey"),
    }).toEqual({ status: true, since: true, replace: true, button: false });
  });

  it("lists the accounts company spending is paid from", () => {
    // #when
    const html = render();

    // #then
    expect({
      accounts: html.includes("Equity Bank ••4521"),
      kind: html.includes("Mobile money"),
      add: html.includes("Add an account"),
      edit: html.includes('aria-label="Edit Company M-Pesa till"'),
    }).toEqual({ accounts: true, kind: true, add: true, edit: true });
  });

  it("shows Zoho Books read-only: status, counts and what didn't sync", () => {
    // #when
    const html = render();

    // #then
    expect({
      status: html.includes(">Connected<"),
      organization: html.includes("Acme Books Ltd"),
      lastSynced: html.includes("6 Nov 2026, 09:20"),
      counts: html.includes("212 synced, 3 waiting, 1 didn&#x27;t sync"),
      failed: html.includes("Twiga Foods"),
      reason: html.includes("The expense account was deleted in Zoho Books."),
    }).toEqual({
      status: true,
      organization: true,
      lastSynced: true,
      counts: true,
      failed: true,
      reason: true,
    });
  });

  it("says when Zoho Books needs reconnecting", () => {
    // #when
    const html = render({
      zoho: { ...connected, status: "needs_reconnect" },
    });

    // #then
    expect({
      paused: html.includes("Syncing is paused"),
      status: html.includes("Needs reconnecting"),
      flag: html.includes(", needs reconnecting"),
    }).toEqual({ paused: true, status: true, flag: true });
  });

  it("says when Zoho Books isn't connected yet", () => {
    // #when
    const html = render({
      zoho: {
        ...connected,
        status: "not_connected",
        organizationName: null,
        failed: [],
      },
    });

    // #then
    expect(html).toContain("Not connected yet.");
  });

  it("shows an accountant everything but the passkey, with no actions", () => {
    // #when
    const html = render({ role: "accountant", query: `category=${id(2)}` });

    // #then
    expect({
      kraPin: html.includes("P051234567X"),
      categories: html.includes("Air travel") && html.includes("Fuel"),
      accounts: html.includes("Equity Bank ••4521"),
      zoho: html.includes("Acme Books Ltd"),
      passkey: html.includes("approval passkey"),
      add: html.includes("Add category") || html.includes("Add an account"),
      edit: html.includes("Edit "),
      sheet: html.includes("data-sheet"),
      forms: (html.match(/<form/g) ?? []).length,
    }).toEqual({
      kraPin: true,
      categories: true,
      accounts: true,
      zoho: true,
      passkey: false,
      add: false,
      edit: false,
      sheet: false,
      forms: 0,
    });
  });

  it("offers to add the first category", () => {
    // #when
    const html = render({ categories: [] });

    // #then
    expect(html).toContain(
      "No categories yet. Add one so people can record spending.",
    );
  });

  it("offers to try again when categories don't load", () => {
    // #when
    const html = render({ categoriesFail: true });

    // #then
    expect({
      title: html.includes("Categories didn&#x27;t load"),
      retry: html.includes("Try again"),
    }).toEqual({ title: true, retry: true });
  });
});

describe("describeSyncCounts", () => {
  it("words what reached Zoho, what's waiting and what didn't", () => {
    // #when
    const text = describeSyncCounts({ synced: 1, pending: 0, failed: 2 });

    // #then
    expect(text).toBe("1 synced, 0 waiting, 2 didn't sync");
  });
});
