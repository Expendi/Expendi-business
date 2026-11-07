import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  PayrollPayment,
  PayrollRun,
  PayrollRunDetail,
  PayrollRunStatus,
  Salary,
} from "@expendi-business/shared";

import type * as DetailSheetModule from "~/components/data/detail-sheet";
import { DashboardProvider } from "~/contexts/dashboard-context";
import { payrollKeys } from "~/features/payment-keys";
import {
  paidByInWords,
  payDayHint,
  runMeta,
  sortRuns,
  sortSalaries,
  waitingRuns,
} from "~/features/payroll/payroll-display";
import { queryKeys } from "~/lib/query-keys";
import { PayrollView } from "./payroll-view";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/payroll",
  useSearchParams: () => navigation.params,
}));
vi.mock("~/contexts/auth-context", () => ({ useAuth: () => ({ api: {} }) }));
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

const SALARIES_CATEGORY = { id: id(30), name: "Salaries" };

const jane: Salary["payee"] = {
  id: id(11),
  name: "Jane Wanjiku",
  kind: "employee",
  method: "mpesa_phone",
  archived: false,
  payoutPhoneConfirmed: true,
  accountEnding: null,
};

const otieno: Salary["payee"] = {
  id: id(12),
  name: "Otieno Ouma",
  kind: "personnel",
  method: "bank",
  archived: false,
  payoutPhoneConfirmed: null,
  accountEnding: "0915",
};

const amina: Salary["payee"] = {
  ...jane,
  id: id(13),
  name: "Amina Hassan",
  payoutPhoneConfirmed: false,
};

function salary(
  n: number,
  payee: Salary["payee"],
  overrides: Partial<Salary> = {},
): Salary {
  return {
    id: id(n),
    state: "active",
    payee,
    category: SALARIES_CATEGORY,
    amountKes: "4512345",
    payDay: 28,
    startsOn: "2026-01-01",
    endsOn: null,
    nextPayDate: "2026-11-28",
    createdAt: "2026-01-01T06:00:00.000Z",
    updatedAt: "2026-11-01T06:00:00.000Z",
    ...overrides,
  };
}

const SALARIES: Salary[] = [
  salary(21, jane),
  salary(22, otieno, { amountKes: "3000000", payDay: 10 }),
  salary(23, amina, { amountKes: "4800000" }),
  salary(
    24,
    { ...jane, id: id(14), name: "Tom Odhiambo" },
    {
      state: "ended",
      endsOn: "2026-10-31",
      nextPayDate: null,
    },
  ),
];

function payment(
  n: number,
  payee: Salary["payee"],
  overrides: Partial<PayrollPayment> = {},
): PayrollPayment {
  return {
    billId: id(n),
    kind: "salary",
    salaryId: id(21),
    payee,
    category: SALARIES_CATEGORY,
    amountKes: "4512345",
    status: "upcoming",
    adjustmentReason: null,
    note: null,
    leftOut: null,
    paidOn: null,
    ...overrides,
  };
}

function run(
  n: number,
  status: PayrollRunStatus,
  payDate: string,
): PayrollRunDetail {
  const approved = status !== "draft";
  const failed = status === "partly_failed";
  return {
    id: id(n),
    payDate,
    status,
    totalKes: "4612345",
    salariesKes: "7512345",
    capKes: "9014814",
    people: 1,
    leftOut: 1,
    adjusted: 1,
    oneOffs: 0,
    progress: approved
      ? { paid: failed ? 0 : 1, paying: 0, failed: failed ? 1 : 0 }
      : { paid: 0, paying: 0, failed: 0 },
    createdAt: "2026-11-23T06:00:00.000Z",
    approvedAt: approved ? "2026-11-25T08:00:00.000Z" : null,
    payments: [
      payment(n * 10 + 1, jane, {
        amountKes: "4612345",
        status: failed ? "payout_failed" : approved ? "paid" : "upcoming",
        adjustmentReason: "Overtime in November",
      }),
      payment(n * 10 + 2, otieno, {
        amountKes: "3000000",
        status: "cancelled",
        leftOut: { reason: "Unpaid leave", at: "2026-11-24T08:00:00.000Z" },
      }),
    ],
  };
}

const DRAFT = run(1, "draft", "2026-11-28");
const FAILED = run(2, "partly_failed", "2026-10-28");
const PAID = run(3, "paid", "2026-09-28");
const listed = (detail: PayrollRunDetail): PayrollRun => {
  const { payments: _payments, ...summary } = detail;
  return summary;
};

function render({
  role = "admin",
  url = "",
  enrolled = true,
  runs = [DRAFT, FAILED, PAID],
  salaries = SALARIES,
  failed = false,
}: {
  role?: "admin" | "accountant";
  url?: string;
  enrolled?: boolean;
  runs?: readonly PayrollRunDetail[];
  salaries?: readonly Salary[];
  failed?: boolean;
} = {}): string {
  navigation.params = new URLSearchParams(url);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  });
  if (failed) {
    const query = queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: payrollKeys.runs(ORG) });
    query.setState({
      ...query.state,
      status: "error",
      error: new Error("Couldn't reach Expendi Business."),
    });
  } else {
    queryClient.setQueryData(payrollKeys.runs(ORG), runs.map(listed));
  }
  for (const detail of runs) {
    queryClient.setQueryData(payrollKeys.run(ORG, detail.id), detail);
  }
  queryClient.setQueryData(payrollKeys.salaries(ORG), salaries);
  queryClient.setQueryData(payrollKeys.margin(ORG), { marginPct: 20 });
  queryClient.setQueryData(queryKeys.approvalPasskey, {
    enrolled,
    enrolledAt: enrolled ? "2026-10-01T09:00:00.000Z" : null,
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

const sheetOf = (html: string) =>
  /<aside data-sheet="">.*<\/aside>/s.exec(html)?.[0] ?? "";

const has = (html: string, texts: readonly string[]) =>
  Object.fromEntries(texts.map((text) => [text, html.includes(text)]));

describe("the payroll page", () => {
  it("shows an admin the stat cards, the runs waiting for them and the runs table", () => {
    // #when
    const html = render();

    // #then
    expect(
      has(html, [
        "Payroll runs",
        "On payroll",
        "Next pay day",
        "Last run",
        "Payroll cap",
        "20%",
        "Payroll ready to review",
        "Some payments failed",
        ">Review run<",
        ">Open run<",
        ">Add salary<",
        "1 changed for this run",
        "1 person, 1 left out",
        "Not approved yet",
      ]),
    ).toEqual(
      Object.fromEntries(
        [
          "Payroll runs",
          "On payroll",
          "Next pay day",
          "Last run",
          "Payroll cap",
          "20%",
          "Payroll ready to review",
          "Some payments failed",
          ">Review run<",
          ">Open run<",
          ">Add salary<",
          "1 changed for this run",
          "1 person, 1 left out",
          "Not approved yet",
        ].map((text) => [text, true]),
      ),
    );
  });

  it("keeps Add salary the page's one coral button: Review run is an outline", () => {
    // #when
    const html = render();

    // #then
    expect({
      reviewRun: /data-variant="outline"[^>]*>Review run</.test(html),
      addSalary: /data-variant="default"[^>]*>.*Add salary</.test(html),
    }).toEqual({ reviewRun: true, addSalary: true });
  });

  it("shows an accountant the same numbers with no actions or banners", () => {
    // #when
    const html = render({ role: "accountant" });

    // #then
    expect(
      has(html, [
        "Only admins change or pay them.",
        "Payroll ready to review",
        ">Add salary<",
        "Payroll cap</button>",
        "On payroll",
      ]),
    ).toEqual({
      "Only admins change or pay them.": true,
      "Payroll ready to review": false,
      ">Add salary<": false,
      "Payroll cap</button>": false,
      "On payroll": true,
    });
  });

  it("filters the runs by status from the URL", () => {
    // #when
    const paid = render({ url: "status=paid" });
    const none = render({ url: "status=paying" });

    // #then
    expect({
      paidRows: (paid.match(/aria-haspopup="dialog"/g) ?? []).length,
      clearAll: none.includes("No runs match these filters"),
    }).toEqual({ paidRows: 2, clearAll: true });
  });

  it("lists salaries with their filters, and never shows an employee's own number", () => {
    // #when
    const html = render({ url: "view=salaries" });

    // #then
    expect({
      chips: has(html, [
        "Filter by status",
        "Filter by pay day",
        "Filter by paid by",
        "Filter by category",
      ]),
      unconfirmed: html.includes("Hasn’t confirmed their M-Pesa number yet."),
      ended: html.includes("Ended 31 Oct 2026"),
      payDay: html.includes("The 10th of each month"),
    }).toEqual({
      chips: {
        "Filter by status": true,
        "Filter by pay day": true,
        "Filter by paid by": true,
        "Filter by category": true,
      },
      unconfirmed: true,
      ended: true,
      payDay: true,
    });
  });

  it("shows the loading error with Try again", () => {
    // #when
    const html = render({ failed: true });

    // #then
    expect(has(html, ["Payroll didn&#x27;t load", ">Try again<"])).toEqual({
      "Payroll didn&#x27;t load": true,
      ">Try again<": true,
    });
  });

  it("offers an admin with no payroll the first step", () => {
    // #when
    const html = render({ runs: [], salaries: [] });

    // #then
    expect({
      empty: html.includes("No payroll runs yet"),
      addSalary: (html.match(/>Add salary</g) ?? []).length,
    }).toEqual({ empty: true, addSalary: 2 });
  });
});

describe("a payroll run's sheet", () => {
  const ACTIONS = [
    "Approve &amp; pay all",
    ">Change pay<",
    ">Leave out<",
    "Add a one-off payment",
    ">Retry<",
  ];

  it("opens a draft from its deep link with the changes and every action", () => {
    // #when
    const sheet = sheetOf(render({ url: `runId=${DRAFT.id}` }));

    // #then
    expect({
      title: sheet.includes("Pay day 28 Nov 2026"),
      heading: sheet.includes("Salaries &amp; personnel"),
      adjusted: sheet.includes("Changed for this run: Overtime in November"),
      leftOut: sheet.includes("Left out: Unpaid leave"),
      position: sheet.includes("1 of 3"),
      actions: has(sheet, ACTIONS),
    }).toEqual({
      title: true,
      heading: true,
      adjusted: true,
      leftOut: true,
      position: true,
      actions: {
        "Approve &amp; pay all": true,
        ">Change pay<": true,
        ">Leave out<": true,
        "Add a one-off payment": true,
        ">Retry<": false,
      },
    });
  });

  it("offers a retry for a failed person, and notes Zoho on a paid run", () => {
    // #when
    const failed = sheetOf(render({ url: `runId=${FAILED.id}` }));
    const paid = sheetOf(render({ url: `runId=${PAID.id}` }));

    // #then
    expect({
      retry: has(failed, ACTIONS),
      zoho: paid.includes("one expense for its total, with no names"),
    }).toEqual({
      retry: {
        "Approve &amp; pay all": false,
        ">Change pay<": false,
        ">Leave out<": false,
        "Add a one-off payment": false,
        ">Retry<": true,
      },
      zoho: true,
    });
  });

  it("shows an accountant the run read-only", () => {
    // #when
    const sheet = sheetOf(
      render({ role: "accountant", url: `runId=${DRAFT.id}` }),
    );

    // #then
    expect({
      viewOnly: sheet.includes("View only. Only admins change or pay payroll."),
      actions: ACTIONS.filter((text) => sheet.includes(text)),
    }).toEqual({ viewOnly: true, actions: [] });
  });

  it("asks an admin without a passkey to set one up before paying", () => {
    // #when
    const html = render({ enrolled: false, url: `runId=${DRAFT.id}` });
    const sheet = sheetOf(html);

    // #then
    expect({
      banner: html.includes("Set up your approval passkey first"),
      approve: sheet.includes("Approve &amp; pay all"),
      note: sheet.includes("Paying needs your approval passkey."),
      oneOff: sheet.includes("Add a one-off payment"),
    }).toEqual({ banner: true, approve: false, note: true, oneOff: true });
  });
});

describe("a salary's sheet", () => {
  it("shows a bank account's ending, but an employee's M-Pesa number without one", () => {
    // #when
    const bank = sheetOf(render({ url: `view=salaries&salaryId=${id(22)}` }));
    const mpesa = sheetOf(render({ url: `view=salaries&salaryId=${id(21)}` }));

    // #then
    expect({
      bank: bank.includes("Bank account ending 0915"),
      mpesa: mpesa.includes("M-Pesa number<"),
      mpesaEnding: mpesa.includes("ending"),
      actions: has(mpesa, [
        "Change net pay",
        "Pay day and category",
        "End salary",
      ]),
    }).toEqual({
      bank: true,
      mpesa: true,
      mpesaEnding: false,
      actions: {
        "Change net pay": true,
        "Pay day and category": true,
        "End salary": true,
      },
    });
  });

  it("shows an accountant a salary with no actions", () => {
    // #when
    const sheet = sheetOf(
      render({ role: "accountant", url: `view=salaries&salaryId=${id(21)}` }),
    );

    // #then
    expect({
      viewOnly: sheet.includes("View only. Only admins change salaries."),
      endSalary: sheet.includes("End salary"),
    }).toEqual({ viewOnly: true, endSalary: false });
  });
});

describe("payroll display", () => {
  it("orders runs and salaries as the headers ask", () => {
    // #when
    const runs = [DRAFT, FAILED, PAID].map(listed);
    const byDate = sortRuns(runs, { key: "payDate", dir: "desc" });
    const byStatus = sortRuns(runs, { key: "status", dir: "asc" });
    const byName = sortSalaries(SALARIES, { key: "person", dir: "asc" });
    const byPay = sortSalaries(SALARIES, { key: "amount", dir: "desc" });

    // #then
    expect({
      byDate: byDate.map((entry) => entry.payDate),
      byStatus: byStatus.map((entry) => entry.status),
      byName: byName.map((entry) => entry.payee.name),
      byPay: byPay.map((entry) => entry.amountKes),
      waiting: waitingRuns(runs).map((entry) => entry.status),
    }).toEqual({
      byDate: ["2026-11-28", "2026-10-28", "2026-09-28"],
      byStatus: ["draft", "partly_failed", "paid"],
      byName: ["Amina Hassan", "Jane Wanjiku", "Otieno Ouma", "Tom Odhiambo"],
      byPay: ["4800000", "4512345", "4512345", "3000000"],
      waiting: ["draft", "partly_failed"],
    });
  });

  it("words a run's second line, its pay day and how a person is paid", () => {
    // #then
    expect({
      meta: runMeta(listed(DRAFT), "2026-11-24"),
      today: payDayHint("2026-11-06", "2026-11-06"),
      late: payDayHint("2026-11-04", "2026-11-06"),
      bank: paidByInWords(otieno),
      ownNumber: paidByInWords({ ...jane, accountEnding: "1234" }),
      personnel: paidByInWords({
        kind: "personnel",
        method: "mpesa_phone",
        accountEnding: "4417",
      }),
    }).toEqual({
      meta: "1 person, 1 left out · In 4 days",
      today: "Today",
      late: "2 days late",
      bank: "Bank account ending 0915",
      ownNumber: "M-Pesa number",
      personnel: "M-Pesa number ending 4417",
    });
  });
});
