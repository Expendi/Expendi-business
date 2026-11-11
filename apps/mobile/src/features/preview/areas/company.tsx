/** DEV PREVIEW — the Company and Profile tabs, and the employee Home. */
import type { JSX } from "react";

import type { PreviewArea, PreviewRoute, PreviewScreen } from "../types";
import { CompanyScreen } from "~/features/company/company-screen";
import { ProfileScreen } from "~/features/company/profile-screen";
import { EmployeeHome } from "~/features/overview/employee-home";
import { previewSession } from "../session";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "../types";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const MEMBERSHIP = uuid(900);
const CATEGORY = { id: uuid(901), name: "Transport" };

function claim(
  n: number,
  fields: {
    merchant: string;
    amountKes: string;
    status: "submitted" | "rejected" | "paid" | "paying";
    createdAt: string;
    rejectedReason?: string;
    paidAt?: string;
  },
): Record<string, unknown> {
  return {
    id: uuid(n),
    status: fields.status,
    merchant: fields.merchant,
    amountKes: fields.amountKes,
    spentOn: fields.createdAt.slice(0, 10),
    description: null,
    category: CATEGORY,
    mpesaCode: null,
    etimsInvoiceNumber: null,
    etimsSupplierPin: null,
    etimsQrPayload: null,
    etimsStatus: "none",
    rejectedReason: fields.rejectedReason ?? null,
    floatId: null,
    submittedBy: {
      membershipId: MEMBERSHIP,
      name: "Brian Otieno",
      email: "brian@mawingulabs.co.ke",
      payoutPhoneConfirmed: true,
    },
    approvedAt: null,
    selfApproved: false,
    paidAt: fields.paidAt ?? null,
    canEdit: fields.status === "submitted" || fields.status === "rejected",
    warnings: [],
    receiptCount: 1,
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
  };
}

const UBER = claim(1, {
  merchant: "Uber",
  amountKes: "617000",
  status: "submitted",
  createdAt: "2026-11-09T08:00:00.000Z",
});
const KAHAWA = claim(2, {
  merchant: "Kahawa Corner",
  amountKes: "124000",
  status: "submitted",
  createdAt: "2026-11-09T09:30:00.000Z",
});
const BOLT = claim(3, {
  merchant: "Bolt",
  amountKes: "64000",
  status: "rejected",
  createdAt: "2026-11-05T08:00:00.000Z",
  rejectedReason: "add the trip receipt",
});
const NAIVAS = claim(4, {
  merchant: "Naivas Westlands",
  amountKes: "218000",
  status: "paid",
  createdAt: "2026-11-03T08:00:00.000Z",
  paidAt: "2026-11-06T09:00:00.000Z",
});

const page = (claims: unknown[]): { claims: unknown[]; nextCursor: null } => ({
  claims,
  nextCursor: null,
});

const status = (name: string): RegExp =>
  new RegExp(`/claims\\?status=${name}&`);

const CLAIMS_FILLED: PreviewRoute[] = [
  { path: status("submitted"), data: page([UBER, KAHAWA]) },
  { path: status("(paying|payout_failed)"), data: page([]) },
  { path: status("rejected"), data: page([BOLT]) },
  { path: status("paid"), data: page([NAIVAS]) },
  { path: /\/claims$/, data: page([UBER, KAHAWA, BOLT, NAIVAS]) },
];

const CLAIMS_EMPTY: PreviewRoute[] = [
  { path: /\/claims(\?|$)/, data: page([]) },
];

function float(left: string, status: "open" | "closed"): Record<string, unknown> {
  return {
    id: uuid(left.length + (status === "open" ? 10 : 20)),
    status,
    holder: { membershipId: MEMBERSHIP, name: "Brian Otieno", email: "brian@mawingulabs.co.ke" },
    yours: true,
    openedAt: "2026-11-01T08:00:00.000Z",
    closedAt: status === "closed" ? "2026-11-08T08:00:00.000Z" : null,
    issuedKes: "500000",
    spentKes: "138000",
    returnedKes: "0",
    writtenOffKes: "0",
    leftKes: left,
    onTheWayKes: "0",
    awaitingApprovalKes: "0",
    spendingCount: 3,
    noReceiptCount: 0,
  };
}

const FLOATS_OPEN: PreviewRoute = {
  path: /\/floats(\?|$)/,
  data: { floats: [float("362000", "open"), float("1000000", "open"), float("0", "closed")] },
};
const FLOATS_NONE: PreviewRoute = { path: /\/floats(\?|$)/, data: { floats: [] } };

const member = (n: number, name: string, status: "active" | "invited"): Record<string, unknown> => ({
  id: uuid(700 + n),
  name,
  email: `${name.split(" ")[0]?.toLowerCase() ?? "person"}@mawingulabs.co.ke`,
  role: n === 0 ? "admin" : "employee",
  status,
  invitedAt: n === 0 ? null : "2026-10-01T08:00:00.000Z",
  payoutPhoneConfirmed: true,
});

const ADMIN_ROUTES: PreviewRoute[] = [
  {
    path: /\/wallet$/,
    data: {
      status: "active",
      address: "0x7a3f0c1d9e8b4a52c6d1f0e9b8a7c6d5e4f3a2b1",
      chain: "base",
      usdcBalance: "3412580000",
      kesEquivalent: { kesCents: "44022282", rate: "129.0" },
    },
  },
  {
    path: /\/members$/,
    data: [
      member(0, "Wanjiru Kamau", "active"),
      member(1, "Brian Otieno", "active"),
      member(2, "Achieng Odhiambo", "active"),
      member(3, "Kevin Mwangi", "invited"),
    ],
  },
  { path: /\/payees(\?|$)/, data: [] },
  FLOATS_OPEN,
];

const ADMIN_ONE_COMPANY_ROUTES: PreviewRoute[] = [
  ...ADMIN_ROUTES.filter((route) => route !== FLOATS_OPEN),
  FLOATS_NONE,
];

const SALARY: PreviewRoute = {
  path: /\/me\/salary-payments$/,
  data: [
    { id: uuid(800), kind: "salary", payDate: "2026-10-28", amountKes: "8500000", status: "paid", paidOn: "2026-10-28" },
  ],
};
const SALARY_NONE: PreviewRoute = { path: /\/me\/salary-payments$/, data: [] };

const EMPLOYEE_FILLED: PreviewRoute[] = [
  ...CLAIMS_FILLED,
  { path: /\/floats(\?|$)/, data: { floats: [float("362000", "open")] } },
  SALARY,
];

const EMPLOYEE_EMPTY: PreviewRoute[] = [
  ...CLAIMS_EMPTY,
  FLOATS_NONE,
  SALARY_NONE,
];

const noop = (): Promise<void> => Promise.resolve();

function company(canSwitch: boolean): () => JSX.Element {
  return function Company(): JSX.Element {
    const { state } = previewSession("admin");
    if (state.status !== "ready") throw new Error("preview session");
    return (
      <CompanyScreen
        me={state.me}
        company={state.company}
        canSwitch={canSwitch}
        onSignOut={noop}
      />
    );
  };
}

function EmployeeHomeFixture(): JSX.Element {
  const { state } = previewSession("employee");
  if (state.status !== "ready") throw new Error("preview session");
  return (
    <EmployeeHome me={state.me} company={state.company} canSwitchCompany={false} />
  );
}

function Profile(): JSX.Element {
  const { state } = previewSession("employee");
  if (state.status !== "ready") throw new Error("preview session");
  return (
    <ProfileScreen
      me={state.me}
      company={state.company}
      canSwitch
      onSignOut={noop}
    />
  );
}

const everything = (data: string): PreviewRoute[] => [
  { path: /\/(claims|floats|me\/salary-payments)/, data },
];

const SCREENS: readonly PreviewScreen[] = [
  {
    key: "company",
    name: "Company",
    role: "admin",
    tab: "company",
    routes: ADMIN_ROUTES,
    render: company(true),
  },
  {
    key: "company-single",
    name: "Company · one company, no floats",
    role: "admin",
    tab: "company",
    routes: ADMIN_ONE_COMPANY_ROUTES,
    render: company(false),
  },
  {
    key: "employee-home",
    name: "Employee home",
    role: "employee",
    tab: "index",
    routes: EMPLOYEE_FILLED,
    render: EmployeeHomeFixture,
  },
  {
    key: "employee-home-empty",
    name: "Employee home · empty",
    role: "employee",
    tab: "index",
    routes: EMPLOYEE_EMPTY,
    render: EmployeeHomeFixture,
  },
  {
    key: "employee-home-loading",
    name: "Employee home · loading",
    role: "employee",
    tab: "index",
    routes: everything(PREVIEW_PENDING),
    render: EmployeeHomeFixture,
  },
  {
    key: "employee-home-error",
    name: "Employee home · error",
    role: "employee",
    tab: "index",
    routes: everything(PREVIEW_FAIL),
    render: EmployeeHomeFixture,
  },
  {
    key: "profile",
    name: "Profile",
    role: "employee",
    tab: "me/profile",
    render: Profile,
  },
];

export const COMPANY_AREA: PreviewArea = { routes: [], screens: SCREENS };
