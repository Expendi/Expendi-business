import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { settingsKeys } from "./settings-api";
import { SettingsView } from "./settings-view";

vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(settingsKeys.company(ORG), {
    id: ORG,
    name: "Acme Ltd",
    kraPin: "P051234567X",
    role,
  });
  queryClient.setQueryData(queryKeys.categories(ORG), [
    { id: id(1), name: "Air travel", etimsNotRequired: true },
    { id: id(2), name: "Fuel", etimsNotRequired: false },
  ]);
  queryClient.setQueryData(settingsKeys.archivedCategories(ORG), [
    { id: id(3), name: "Old marketing", etimsNotRequired: false },
  ]);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled: false,
    enrolledAt: null,
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
  it("lets an admin add, rename, archive, restore and mark categories, and set up their passkey", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      kraPin: html.includes("P051234567X"),
      exempt: html.includes("No invoice expected"),
      archived: html.includes("Old marketing"),
      add: html.includes("Add category"),
      rename: html.includes(">Rename<"),
      archive: html.includes(">Archive<"),
      restore: html.includes(">Restore<"),
      markExempt: html.includes("Mark no invoice expected"),
      passkey: html.includes("Set up approval passkey"),
    }).toEqual({
      kraPin: true,
      exempt: true,
      archived: true,
      add: true,
      rename: true,
      archive: true,
      restore: true,
      markExempt: true,
      passkey: true,
    });
  });

  it("shows an accountant the details and categories, with no actions", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      kraPin: html.includes("P051234567X"),
      categories: html.includes("Air travel") && html.includes("Fuel"),
      archived: html.includes("Old marketing"),
      passkey: html.includes("approval passkey"),
      forms: (html.match(/<form/g) ?? []).length,
      buttons: (html.match(/<button/g) ?? []).length,
    }).toEqual({
      kraPin: true,
      categories: true,
      archived: true,
      passkey: false,
      forms: 0,
      buttons: 0,
    });
  });
});
