import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PayrollRunDetail,
  PayrollRunPayment,
  Salary,
  SalaryAmountChallenge,
} from "@expendi-business/shared";

import type { PayrollPaymentRequest } from "./payroll-payment";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { holdFrom } from "~/features/bills/bill-payment";
import { createApiClient } from "~/lib/api";
import { approveWithPasskey } from "~/lib/approval";
import { payrollMarginSteps, salaryAmountSteps } from "./payroll-api";
import { capRoom } from "./payroll-display";
import {
  changeDraftRun,
  confirmPayrollPayment,
  parseMarginPct,
  preparePayrollPayment,
  progressInWords,
} from "./payroll-payment";

const API = "https://api.example.com";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const RUN = "00000000-0000-4000-8000-0000000000bb";
const CHALLENGE = "00000000-0000-4000-8000-0000000000cc";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const payee = (n: number) => ({
  id: id(10 + n),
  name: `Person ${String(n)}`,
  kind: "employee" as const,
  method: "mpesa_phone" as const,
  archived: false,
  payoutPhoneConfirmed: true,
  accountEnding: null,
});

const run: PayrollRunDetail = {
  id: RUN,
  payDate: "2026-11-28",
  status: "draft",
  totalKes: "9000000",
  salariesKes: "9000000",
  capKes: "10800000",
  people: 2,
  leftOut: 0,
  adjusted: 0,
  oneOffs: 0,
  progress: { paid: 0, paying: 0, failed: 0 },
  createdAt: "2026-11-23T06:00:00.000Z",
  approvedAt: null,
  payments: [1, 2].map((n) => ({
    billId: id(n),
    kind: "salary",
    salaryId: id(20 + n),
    payee: payee(n),
    category: { id: id(30), name: "Salaries" },
    amountKes: "4500000",
    status: "upcoming",
    adjustmentReason: null,
    note: null,
    leftOut: null,
    paidOn: null,
  })),
};

const payment: PayrollRunPayment = {
  challengeId: CHALLENGE,
  options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  runId: RUN,
  people: [
    {
      billId: id(1),
      payeeName: "Person 1",
      paidTo: { method: "mpesa_phone", label: "M-Pesa ending 5678" },
      amountKes: "4000000",
      receivesKes: "4000000",
      orders: 1,
      payoutIds: [id(101)],
      rate: "128.68",
      usdc: "310848616",
      feeAllowanceUsdc: "3108486",
      maxDebitUsdc: "313957102",
    },
  ],
  totals: {
    receivesKes: "4000000",
    usdc: "310848616",
    feeAllowanceUsdc: "3108486",
    maxDebitUsdc: "313957102",
  },
  cap: { capKes: "10800000", committedKes: "0", withinCap: true },
  wallet: { availableUsdc: "900000000", shortfallUsdc: "0", topUpKes: null },
};

const assertion: PasskeyAssertion = {
  id: "Y3JlZGVudGlhbA",
  rawId: "Y3JlZGVudGlhbA",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    authenticatorData: "AAAA",
    signature: "c2ln",
  },
  clientExtensionResults: {},
};

const api = createApiClient({
  baseUrl: API,
  getAccessToken: () => Promise.resolve("token"),
});

type Reply = (url: string, init: RequestInit) => Response;

function stubFetch(reply: Reply) {
  const fetcher = vi.fn((url: string, init: RequestInit) =>
    Promise.resolve(reply(url, init)),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const ok = (data: unknown, status = 200) =>
  Response.json({ success: true, data }, { status });

function sent(fetcher: ReturnType<typeof stubFetch>) {
  return fetcher.mock.calls.map(([url, init]) => [
    init.method,
    url.replace(`${API}/organizations/${ORG}`, ""),
    typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
  ]);
}

const PAY_ALL: PayrollPaymentRequest = {
  runId: RUN,
  retryBillId: null,
  secondConfirmation: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adjusting and paying a payroll run from the dashboard", () => {
  it("changes the draft, then pays everyone with one signature, once", async () => {
    // #given
    const paid: PayrollRunDetail = {
      ...run,
      status: "paying",
      progress: { paid: 0, paying: 2, failed: 0 },
      approvedAt: "2026-11-25T08:00:00.000Z",
    };
    const fetcher = stubFetch((url) => {
      if (url.endsWith("/confirm")) return ok(paid);
      if (url.endsWith(`/payroll-runs/${RUN}/payment`)) return ok(payment, 201);
      return ok(run);
    });
    const sign = vi.fn(() => Promise.resolve(assertion));

    // #when
    await changeDraftRun(api, ORG, RUN, {
      action: "adjust",
      billId: id(1),
      request: { amountKes: "40,000", reason: "Unpaid leave" },
    });
    await changeDraftRun(api, ORG, RUN, {
      action: "leave_out",
      billId: id(2),
      reason: "Left in October",
    });
    await changeDraftRun(api, ORG, RUN, {
      action: "one_off",
      request: { payeeId: id(11), amountKes: "5000", reason: "Overtime" },
    });
    const outcome = await approveWithPasskey(
      {
        request: (request: PayrollPaymentRequest) =>
          preparePayrollPayment(api, ORG, request),
        confirm: (challenge, signed) =>
          confirmPayrollPayment(
            api,
            ORG,
            challenge.runId,
            challenge.challengeId,
            signed,
          ),
      },
      PAY_ALL,
      sign,
    );

    // #then
    expect({
      outcome,
      signatures: sign.mock.calls,
      requests: sent(fetcher),
    }).toEqual({
      outcome: { status: "approved", result: paid },
      signatures: [[payment.options]],
      requests: [
        [
          "PATCH",
          `/payroll-runs/${RUN}/payments/${id(1)}`,
          { amountKes: "40,000", reason: "Unpaid leave" },
        ],
        [
          "POST",
          `/payroll-runs/${RUN}/payments/${id(2)}/leave-out`,
          { reason: "Left in October" },
        ],
        [
          "POST",
          `/payroll-runs/${RUN}/one-offs`,
          { payeeId: id(11), amountKes: "5000", reason: "Overtime" },
        ],
        ["POST", `/payroll-runs/${RUN}/payment`, { secondConfirmation: false }],
        [
          "POST",
          `/payroll-runs/${RUN}/payment/${CHALLENGE}/confirm`,
          { response: assertion },
        ],
      ],
    });
  });

  it("asks again with a second confirmation when a payee's details changed in the last 24 hours", async () => {
    // #given
    const hold = {
      reason: "payee_details_changed",
      payees: [
        {
          payeeId: id(11),
          name: "Person 1",
          detailsChangedAt: "2026-11-25T07:00:00.000Z",
        },
      ],
    };
    const fetcher = stubFetch((_url, init) =>
      init.body === JSON.stringify({ secondConfirmation: false })
        ? Response.json(
            {
              success: false,
              error: {
                _tag: "Conflict",
                message: "Confirm again",
                details: hold,
              },
            },
            { status: 409 },
          )
        : ok(payment, 201),
    );

    // #when
    const first = await preparePayrollPayment(api, ORG, PAY_ALL).catch(
      (error: unknown) => holdFrom(error),
    );
    const second = await preparePayrollPayment(api, ORG, {
      ...PAY_ALL,
      secondConfirmation: true,
    });

    // #then
    expect({ first, second, requests: sent(fetcher) }).toEqual({
      first: hold,
      second: payment,
      requests: [
        ["POST", `/payroll-runs/${RUN}/payment`, { secondConfirmation: false }],
        ["POST", `/payroll-runs/${RUN}/payment`, { secondConfirmation: true }],
      ],
    });
  });

  it("retries one failed person through their own route", async () => {
    // #given
    const fetcher = stubFetch(() => ok(payment, 201));

    // #when
    await preparePayrollPayment(api, ORG, {
      runId: RUN,
      retryBillId: id(2),
      secondConfirmation: false,
    });

    // #then
    expect(sent(fetcher)).toEqual([
      [
        "POST",
        `/payroll-runs/${RUN}/payments/${id(2)}/retry`,
        { secondConfirmation: false },
      ],
    ]);
  });
});

describe("passkey-confirmed payroll settings", () => {
  it("changes net pay: the challenge's change goes back with one signature", async () => {
    // #given
    const challenge: SalaryAmountChallenge = {
      status: "confirmation_required",
      challengeId: CHALLENGE,
      options: payment.options,
      change: { salaryId: id(21), amountKesCents: "5000000" },
    };
    const salary: Salary = {
      id: id(21),
      state: "active",
      payee: payee(1),
      category: { id: id(30), name: "Salaries" },
      amountKes: "5000000",
      payDay: 28,
      startsOn: "2026-01-01",
      endsOn: null,
      nextPayDate: "2026-12-28",
      createdAt: "2026-01-01T06:00:00.000Z",
      updatedAt: "2026-11-25T06:00:00.000Z",
    };
    const fetcher = stubFetch((url) =>
      url.endsWith("/confirm") ? ok(salary) : ok(challenge),
    );
    const sign = vi.fn(() => Promise.resolve(assertion));

    // #when
    const outcome = await approveWithPasskey(
      salaryAmountSteps(api, ORG, id(21)),
      "50,000",
      sign,
    );

    // #then
    expect({
      outcome,
      signatures: sign.mock.calls.length,
      requests: sent(fetcher),
    }).toEqual({
      outcome: { status: "approved", result: salary },
      signatures: 1,
      requests: [
        ["POST", `/salaries/${id(21)}/amount`, { amountKes: "50,000" }],
        [
          "POST",
          `/salaries/amount-changes/${CHALLENGE}/confirm`,
          { change: challenge.change, response: assertion },
        ],
      ],
    });
  });

  it("changes the payroll margin the same way", async () => {
    // #given
    const challenge = {
      status: "confirmation_required",
      challengeId: CHALLENGE,
      options: payment.options,
      change: { marginPct: 25 },
    };
    const fetcher = stubFetch((url) =>
      url.endsWith("/confirm") ? ok({ marginPct: 25 }) : ok(challenge),
    );
    const sign = vi.fn(() => Promise.resolve(assertion));

    // #when
    const outcome = await approveWithPasskey(
      payrollMarginSteps(api, ORG),
      25,
      sign,
    );

    // #then
    expect({
      outcome,
      signatures: sign.mock.calls.length,
      requests: sent(fetcher),
    }).toEqual({
      outcome: { status: "approved", result: { marginPct: 25 } },
      signatures: 1,
      requests: [
        ["POST", "/settings/payroll-margin", { marginPct: 25 }],
        [
          "POST",
          `/settings/payroll-margin/${CHALLENGE}/confirm`,
          { change: { marginPct: 25 }, response: assertion },
        ],
      ],
    });
  });

  it("sends nothing when the admin backs out of the passkey prompt", async () => {
    // #given
    const fetcher = stubFetch(() =>
      ok({
        status: "confirmation_required",
        challengeId: CHALLENGE,
        options: payment.options,
        change: { marginPct: 25 },
      }),
    );

    // #when
    const outcome = await approveWithPasskey(
      payrollMarginSteps(api, ORG),
      25,
      () => Promise.resolve(null),
    );

    // #then
    expect({ outcome, requests: sent(fetcher).length }).toEqual({
      outcome: { status: "cancelled" },
      requests: 1,
    });
  });
});

describe("payroll display", () => {
  it("reads the cap, the progress and a typed margin", () => {
    // #then
    expect({
      under: capRoom(run),
      over: capRoom({ ...run, totalKes: "11000000" }),
      draft: progressInWords(run),
      paying: progressInWords({
        status: "partly_failed",
        progress: { paid: 2, paying: 1, failed: 1 },
      }),
      failedOnly: progressInWords({
        status: "partly_failed",
        progress: { paid: 0, paying: 0, failed: 1 },
      }),
      margins: ["20", "20%", "101", "1.5", ""].map(parseMarginPct),
    }).toEqual({
      under: { overCap: false, cents: "1800000" },
      over: { overCap: true, cents: "200000" },
      draft: null,
      paying: "2 paid · 1 being paid, 1 failed",
      failedOnly: "1 failed",
      margins: [20, 20, null, null, null],
    });
  });
});
