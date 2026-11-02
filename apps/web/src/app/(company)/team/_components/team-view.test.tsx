import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Member } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { queryKeys } from "~/lib/query-keys";
import { TeamView } from "./team-view";

vi.mock("~/contexts/auth-context", () => ({
  useAuth: () => ({ api: {}, privyUserId: "did:privy:test" }),
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const members: Member[] = [
  {
    id: id(1),
    name: "Wanjiru Kamau",
    email: "wanjiru@example.com",
    role: "admin",
    status: "active",
    invitedAt: null,
    payoutPhoneConfirmed: true,
  },
  {
    id: id(2),
    name: "Grace Otieno",
    email: "grace@example.com",
    role: "accountant",
    status: "invited",
    invitedAt: "2026-11-01T09:00:00.000Z",
    payoutPhoneConfirmed: false,
  },
];

function render(role: "admin" | "accountant"): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.members(ORG), members);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <TeamView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

describe("the team", () => {
  it("lets an admin invite anyone, accountants included, change roles and remove people", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      invite: html.includes("Send invite"),
      accountantRole: html.includes('<option value="accountant">'),
      roleSelect: html.includes("Role for Wanjiru Kamau"),
      resend: html.includes("Resend invite"),
      remove: (html.match(/>Remove</g) ?? []).length,
    }).toEqual({
      invite: true,
      accountantRole: true,
      roleSelect: true,
      resend: true,
      remove: 2,
    });
  });

  it("shows an accountant everyone and their role, with no actions", () => {
    // #when
    const html = render("accountant");

    // #then
    expect({
      people: html.includes("Wanjiru Kamau") && html.includes("Grace Otieno"),
      invited: html.includes("Invited"),
      forms: (html.match(/<form/g) ?? []).length,
      selects: (html.match(/<select/g) ?? []).length,
      buttons: (html.match(/<button/g) ?? []).length,
    }).toEqual({
      people: true,
      invited: true,
      forms: 0,
      selects: 0,
      buttons: 0,
    });
  });
});
