import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  PayrollRunDetail,
  PayrollRunStatus,
  Salary,
} from "@expendi-business/shared";

import { DashboardProvider } from "~/contexts/dashboard-context";
import { payrollKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { PayrollView } from "./payroll-view";

vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RUN = "00000000-0000-4000-8000-0000000000bb";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const payee = {
  id: id(11),
  name: "Jane Wanjiku",
  kind: "employee" as const,
  method: "mpesa_phone" as const,
  archived: false,
  payoutPhoneConfirmed: true,
};

const salary: Salary = {
  id: id(21),
  state: "active",
  payee,
  category: { id: id(30), name: "Salaries" },
  amountKes: "4512345",
  payDay: 28,
  startsOn: "2026-01-01",
  endsOn: null,
  nextPayDate: "2026-12-28",
  createdAt: "2026-01-01T06:00:00.000Z",
  updatedAt: "2026-11-01T06:00:00.000Z",
};

function runWith(status: PayrollRunStatus): PayrollRunDetail {
  return {
    id: RUN,
    payDate: "2026-11-28",
    status,
    totalKes: "4612345",
    salariesKes: "4512345",
    capKes: "5414814",
    people: 1,
    leftOut: 1,
    progress:
      status === "draft"
        ? { paid: 0, paying: 0, failed: 0 }
        : { paid: 0, paying: 0, failed: 1 },
    createdAt: "2026-11-23T06:00:00.000Z",
    approvedAt: status === "draft" ? null : "2026-11-25T08:00:00.000Z",
    payments: [
      {
        billId: id(1),
        kind: "salary",
        salaryId: salary.id,
        payee,
        category: salary.category,
        amountKes: "4612345",
        status: status === "draft" ? "upcoming" : "payout_failed",
        adjustmentReason: "Overtime in November",
        note: null,
        leftOut: null,
        paidOn: null,
      },
      {
        billId: id(2),
        kind: "salary",
        salaryId: id(22),
        payee: { ...payee, id: id(12), name: "Otieno Ouma" },
        category: salary.category,
        amountKes: "3000000",
        status: "cancelled",
        adjustmentReason: null,
        note: null,
        leftOut: { reason: "Unpaid leave", at: "2026-11-24T08:00:00.000Z" },
        paidOn: null,
      },
    ],
  };
}

function render(
  role: "admin" | "accountant",
  status: PayrollRunStatus = "draft",
): string {
  const queryClient = new QueryClient();
  const run = runWith(status);
  queryClient.setQueryData(payrollKeys.runs(ORG), [run]);
  queryClient.setQueryData(payrollKeys.run(ORG, RUN), run);
  queryClient.setQueryData(payrollKeys.salaries(ORG), [salary]);
  queryClient.setQueryData(payrollKeys.margin(ORG), { marginPct: 20 });
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider
        company={{ organizationId: ORG, name: "Acme Ltd", role }}
      >
        <PayrollView />
      </DashboardProvider>
    </QueryClientProvider>,
  );
}

const ACTIONS = [
  "Approve &amp; pay all",
  "Change pay",
  "Leave out<",
  "Add a one-off payment",
  "Add salary",
  "Change with passkey",
  ">Retry<",
];

const shown = (html: string, texts: readonly string[]) =>
  Object.fromEntries(texts.map((text) => [text, html.includes(text)]));

describe("the payroll page", () => {
  it("opens the draft run for an admin with its payments and every action", () => {
    // #when
    const html = render("admin");

    // #then
    expect({
      actions: shown(html, ACTIONS),
      salary: html.includes("45,123.45"),
      adjusted: html.includes("Changed for this run: Overtime in November"),
      leftOut: html.includes("Left out: Unpaid leave"),
      margin: html.includes(">20%<"),
    }).toEqual({
      actions: {
        "Approve &amp; pay all": true,
        "Change pay": true,
        "Leave out<": true,
        "Add a one-off payment": true,
        "Add salary": true,
        "Change with passkey": true,
        ">Retry<": false,
      },
      salary: true,
      adjusted: true,
      leftOut: true,
      margin: true,
    });
  });

  it("offers an admin a retry for a failed person once the run is paid", () => {
    // #when
    const html = render("admin", "partly_failed");

    // #then
    expect(
      shown(html, ["Approve &amp; pay all", "Change pay", ">Retry<"]),
    ).toEqual({
      "Approve &amp; pay all": false,
      "Change pay": false,
      ">Retry<": true,
    });
  });

  it("shows an accountant the runs, payments and salaries with no actions", () => {
    // #when
    const draft = render("accountant");
    const failed = render("accountant", "partly_failed");

    // #then
    expect({
      salaries: draft.includes("45,123.45") && draft.includes("Jane Wanjiku"),
      payments:
        draft.includes("46,123.45") && draft.includes("Left out: Unpaid leave"),
      margin: draft.includes(">20%<"),
      draftActions: shown(draft, ACTIONS),
      failedActions: shown(failed, ACTIONS),
    }).toEqual({
      salaries: true,
      payments: true,
      margin: true,
      draftActions: Object.fromEntries(ACTIONS.map((text) => [text, false])),
      failedActions: Object.fromEntries(ACTIONS.map((text) => [text, false])),
    });
  });
});
