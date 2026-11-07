import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Payee } from "@expendi-business/shared";

import type * as DetailSheetModule from "~/components/data/detail-sheet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { sortPayees } from "~/features/payees/payee-display";
import { ACTIVE_PAYEES, ARCHIVED_PAYEES } from "~/features/payees/payees-api";
import { payeeKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { PayeesView } from "./payees-view";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/payees",
  useSearchParams: () => navigation.params,
}));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
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

const base = {
  membershipId: null,
  payoutPhoneConfirmed: null,
  detailsChangedAt: null,
  secondConfirmationUntil: null,
  archived: false,
  member: null,
  billCount: 0,
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
  billCount: 4,
};

const employee: Payee = {
  ...base,
  id: id(2),
  kind: "employee",
  name: "Jane Wanjiku",
  membershipId: id(3),
  payoutPhoneConfirmed: true,
  details: { method: "mpesa_phone", accountName: "Jane Wanjiku" },
  member: { name: "Jane Wanjiku", email: "jane@example.com", inTeam: true },
};

const leaver: Payee = {
  ...employee,
  id: id(4),
  name: "Otieno Ouma",
  archived: true,
  member: { name: "Otieno Ouma", email: "otieno@example.com", inTeam: false },
};

const outside: Payee = {
  ...base,
  id: id(5),
  kind: "vendor",
  name: "Canva",
  details: { method: "outside" },
};

function render({
  role = "admin",
  url = "",
  enrolled = true,
  active = [supplier, employee, outside],
  archived = [leaver],
}: {
  role?: "admin" | "accountant";
  url?: string;
  enrolled?: boolean;
  active?: readonly Payee[];
  archived?: readonly Payee[];
} = {}): string {
  navigation.params = new URLSearchParams(url);
  const queryClient = new QueryClient();
  queryClient.setQueryData(payeeKeys.list(ORG, ACTIVE_PAYEES), active);
  queryClient.setQueryData(payeeKeys.list(ORG, ARCHIVED_PAYEES), archived);
  for (const payee of [...active, ...archived]) {
    queryClient.setQueryData(payeeKeys.detail(ORG, payee.id), payee);
  }
  queryClient.setQueryData(payeeKeys.banks(ORG), [
    { code: "KCBLKENX", name: "KCB Bank Kenya" },
  ]);
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-01T09:00:00.000Z" : null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <PayeesView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const sheetOf = (html: string) =>
  /<aside data-sheet="">.*<\/aside>/s.exec(html)?.[0] ?? "";

const ACTIONS = [
  "Add payee",
  "Change payment details",
  "Rename or change kind",
  "Archive payee",
  "Restore payee",
];

const actionsIn = (html: string) =>
  ACTIONS.filter((label) => new RegExp(`>${label}</button>`).test(html));

describe("the payee list", () => {
  it("shows an admin the tabs with counts, each payee's details and Add payee", () => {
    // #when
    const html = render();

    // #then
    expect({
      active: /Active<span[^>]*>3</.test(html),
      archived: /Archived<span[^>]*>1</.test(html),
      bank: html.includes("KCB Bank Kenya 1234567890"),
      employee: html.includes("Employee · jane@example.com"),
      ownNumber: html.includes("Their confirmed number"),
      recentlyChanged: html.includes("Details changed in the last 24 hours"),
      never: html.includes(">Never<"),
      reimbursements: html.includes("besides staff reimbursements"),
      actions: actionsIn(html),
    }).toEqual({
      active: true,
      archived: true,
      bank: true,
      employee: true,
      ownNumber: true,
      recentlyChanged: true,
      never: true,
      reimbursements: true,
      actions: ["Add payee"],
    });
  });

  it("shows an accountant the same payees, with no actions", () => {
    // #when
    const html = render({ role: "accountant" });

    // #then
    expect({
      bank: html.includes("KCB Bank Kenya 1234567890"),
      actions: actionsIn(html),
    }).toEqual({ bank: true, actions: [] });
  });

  it("filters by kind and search from the URL, and lists archived payees", () => {
    // #when
    const vendors = render({ url: "kind=vendor" });
    const none = render({ url: "q=nobody" });
    const archived = render({ url: "tab=archived" });

    // #then
    expect({
      vendorOnly:
        vendors.includes("Canva") && !vendors.includes("Acme Stationers"),
      noMatch: none.includes("No payees match this search"),
      archived: archived.includes("Otieno Ouma") && !archived.includes("Canva"),
    }).toEqual({ vendorOnly: true, noMatch: true, archived: true });
  });

  it("says what to do when there are no payees yet", () => {
    // #when
    const active = render({ active: [], archived: [] });
    const archived = render({ active: [], archived: [], url: "tab=archived" });

    // #then
    expect({
      active: active.includes("No payees here yet"),
      archived: archived.includes("No archived payees"),
    }).toEqual({ active: true, archived: true });
  });
});

describe("a payee's sheet", () => {
  it("shows an admin the details, the hold, the bills link and the actions", () => {
    // #when
    const sheet = sheetOf(render({ url: `id=${supplier.id}` }));

    // #then
    expect({
      accountNumber: sheet.includes("1234567890"),
      bank: sheet.includes("KCB Bank Kenya"),
      hold: sheet.includes("needs a second confirmation"),
      bills: sheet.includes(`href="/bills?payee=${supplier.id}"`),
      billCount: sheet.includes("4 bills"),
      position: sheet.includes("of 3"),
      actions: actionsIn(sheet),
    }).toEqual({
      accountNumber: true,
      bank: true,
      hold: true,
      bills: true,
      billCount: true,
      position: false,
      actions: [
        "Change payment details",
        "Rename or change kind",
        "Archive payee",
      ],
    });
  });

  it("shows the team member and where salaries are paid", () => {
    // #when
    const sheet = sheetOf(render({ url: `id=${employee.id}` }));

    // #then
    expect({
      member: sheet.includes("Jane Wanjiku · jane@example.com"),
      payroll: sheet.includes('href="/payroll"'),
      bills: sheet.includes("/bills?payee="),
    }).toEqual({ member: true, payroll: true, bills: false });
  });

  it("offers an admin Restore on an archived payee, and says the person left", () => {
    // #when
    const sheet = sheetOf(render({ url: `tab=archived&id=${leaver.id}` }));

    // #then
    expect({
      archived: sheet.includes("This payee is archived."),
      left: sheet.includes("No longer in the team."),
      actions: actionsIn(sheet),
    }).toEqual({
      archived: true,
      left: true,
      actions: ["Restore payee"],
    });
  });

  it("shows an accountant the details read-only", () => {
    // #when
    const sheet = sheetOf(
      render({ role: "accountant", url: `id=${employee.id}` }),
    );

    // #then
    expect({
      paidTo: sheet.includes("Their confirmed number"),
      viewOnly: sheet.includes("View only. Only admins change payees."),
      position: sheet.includes("3 of 3"),
      actions: actionsIn(sheet),
    }).toEqual({ paidTo: true, viewOnly: true, position: true, actions: [] });
  });
});

describe("sortPayees", () => {
  it("sorts by name, method or when the details changed", () => {
    // #when
    const payees = [supplier, employee, outside];
    const names = (list: readonly Payee[]) => list.map((payee) => payee.name);

    // #then
    expect({
      name: names(sortPayees(payees, { key: "name", dir: "asc" })),
      method: names(sortPayees(payees, { key: "method", dir: "asc" })),
      changed: names(sortPayees(payees, { key: "changed", dir: "desc" })),
    }).toEqual({
      name: ["Acme Stationers", "Canva", "Jane Wanjiku"],
      method: ["Jane Wanjiku", "Acme Stationers", "Canva"],
      changed: ["Acme Stationers", "Canva", "Jane Wanjiku"],
    });
  });
});
