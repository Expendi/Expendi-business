import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Member, Payee } from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { ACTIVE_PAYEES } from "~/features/payees/payees-api";
import { payeeKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { PayeeDetailPanel } from "./payee-panel";
import { PayeesView } from "./payees-view";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const base = {
  membershipId: null,
  payoutPhoneConfirmed: null,
  detailsChangedAt: null,
  secondConfirmationUntil: null,
  archived: false,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
} as const;

const supplier: Payee = {
  ...base,
  id: id(1),
  kind: "supplier",
  name: "Acme Stationers",
  details: {
    method: "bank",
    bankCode: "KCBLKENX",
    accountNumber: "1234567890",
    accountName: "Acme Stationers Ltd",
  },
  detailsChangedAt: "2026-11-02T06:00:00.000Z",
  secondConfirmationUntil: "2026-11-03T06:00:00.000Z",
};

const employee: Payee = {
  ...base,
  id: id(2),
  kind: "employee",
  name: "Jane Wanjiku",
  membershipId: id(3),
  payoutPhoneConfirmed: true,
  details: { method: "mpesa_phone", accountName: "Jane Wanjiku" },
};

const jane: Member = {
  id: id(3),
  name: "Jane Wanjiku",
  email: "jane@example.com",
  role: "employee",
  status: "active",
  invitedAt: null,
  payoutPhoneConfirmed: true,
};

function seed(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(payeeKeys.list(ORG, ACTIVE_PAYEES), [
    supplier,
    employee,
  ]);
  queryClient.setQueryData(payeeKeys.detail(ORG, supplier.id), supplier);
  queryClient.setQueryData(payeeKeys.detail(ORG, employee.id), employee);
  queryClient.setQueryData(payeeKeys.banks(ORG), [
    { code: "KCBLKENX", name: "KCB Bank Kenya" },
  ]);
  queryClient.setQueryData(queryKeys.members(ORG), [jane]);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  return queryClient;
}

function render(
  role: "admin" | "accountant",
  content: (canAct: boolean) => ReactNode,
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={seed()}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        {content(role === "admin")}
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const ACTIONS = [
  "Add payee",
  "Change payment details",
  "Rename or change kind",
  "Archive payee",
];

const actionsIn = (html: string) =>
  ACTIONS.filter((label) => html.includes(`>${label}<`));

describe("the payee list", () => {
  it("shows an admin each payee with its payment details and the Add payee action", () => {
    // #when
    const html = render("admin", () => <PayeesView />);

    // #then
    expect({
      supplier: html.includes("Acme Stationers"),
      bank: html.includes("Bank account · KCB Bank Kenya 1234567890"),
      employee: html.includes("M-Pesa number · Their confirmed number"),
      recentlyChanged: html.includes("Details changed in the last 24 hours"),
      actions: actionsIn(html),
    }).toEqual({
      supplier: true,
      bank: true,
      employee: true,
      recentlyChanged: true,
      actions: ["Add payee"],
    });
  });

  it("shows an accountant the same payees, with no actions", () => {
    // #when
    const html = render("accountant", () => <PayeesView />);

    // #then
    expect({
      bank: html.includes("Bank account · KCB Bank Kenya 1234567890"),
      actions: actionsIn(html),
      buttons: (html.match(/<button/g) ?? []).length,
    }).toEqual({
      bank: true,
      actions: [],
      // One per payee name, to open its details.
      buttons: 2,
    });
  });
});

describe("a payee's details", () => {
  function panel(payeeId: string) {
    return function Panel(canAct: boolean): ReactNode {
      return (
        <PayeeDetailPanel
          organizationId={ORG}
          payeeId={payeeId}
          canAct={canAct}
          onClose={() => undefined}
        />
      );
    };
  }

  it("shows an admin the account number as the API returns it, and the actions", () => {
    // #when
    const html = render("admin", panel(supplier.id));

    // #then
    expect({
      accountNumber: html.includes("1234567890"),
      accountName: html.includes("Acme Stationers Ltd"),
      bank: html.includes("KCB Bank Kenya"),
      hold: html.includes("needs a second confirmation"),
      actions: actionsIn(html),
    }).toEqual({
      accountNumber: true,
      accountName: true,
      bank: true,
      hold: true,
      actions: [
        "Change payment details",
        "Rename or change kind",
        "Archive payee",
      ],
    });
  });

  it("shows an accountant the details read-only: only Close", () => {
    // #when
    const html = render("accountant", panel(employee.id));

    // #then
    expect({
      member: html.includes("Jane Wanjiku · jane@example.com"),
      paidTo: html.includes("Their confirmed number"),
      actions: actionsIn(html),
      buttons: html.match(/<button[^>]*>[^<]*</g),
    }).toEqual({
      member: true,
      paidTo: true,
      actions: [],
      buttons: [expect.stringMatching(/>Close<$/)],
    });
  });
});
