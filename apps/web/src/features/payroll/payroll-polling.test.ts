import type { QueryKey, QueryObserverOptions } from "@tanstack/react-query";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { PayrollRun, PayrollRunDetail } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import { PAYROLL_RUN_DETAILS } from "~/app/dev/preview/_harness/fixtures/payroll";
import { payrollRunQuery, payrollRunsQuery } from "./payroll-api";

// TanStack Query never polls on a server, which it decides from `window`
// once, when it loads; so this file runs as a browser would.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
});

const ORG = "00000000-0000-4000-8000-0000000000aa";

const SAMPLE = PAYROLL_RUN_DETAILS.find((run) => run.payments.length > 1);
if (!SAMPLE) throw new Error("No sample run with several people");
const RUN: PayrollRunDetail = SAMPLE;

/** Everyone in the run paid but the first person, still being paid. */
const BEING_PAID: PayrollRunDetail = {
  ...RUN,
  status: "paying",
  payments: RUN.payments.map((payment, at) => ({
    ...payment,
    leftOut: null,
    status: at === 0 ? "paying" : "paid",
    paymentReceipts: [],
  })),
};

/** Their salary went out in two cash-outs. */
const PAID: PayrollRunDetail = {
  ...BEING_PAID,
  status: "paid",
  payments: BEING_PAID.payments.map((payment, at) =>
    at === 0
      ? {
          ...payment,
          status: "paid",
          paymentReceipts: [
            { kind: "mpesa", code: "UKD1AAAAAA" },
            { kind: "mpesa", code: "UKD2BBBBBB" },
          ],
        }
      : payment,
  ),
};

const listed = ({
  payments: _payments,
  ...run
}: PayrollRunDetail): PayrollRun => run;

interface Server {
  run: PayrollRunDetail;
}

function fakeApi(server: Server): { api: ApiClient; asked: string[] } {
  const asked: string[] = [];
  const refuse = () => Promise.reject(new Error("Not asked in this test"));
  const api: ApiClient = {
    get: (path, schema) => {
      asked.push(path);
      const answer = path.endsWith("/payroll-runs")
        ? [listed(server.run)]
        : server.run;
      return Promise.resolve(schema.parse(answer));
    },
    post: refuse,
    put: refuse,
    patch: refuse,
    delete: refuse,
  };
  return { api, asked };
}

function follow<T, K extends QueryKey>(
  options: QueryObserverOptions<T, Error, T, T, K>,
) {
  const observer = new QueryObserver(new QueryClient(), options);
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    data: () => observer.getCurrentResult().data,
    stop: unsubscribe,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a payroll run being paid", () => {
  it("shows each person paid, with their receipts, without a reload", async () => {
    // #given
    const server: Server = { run: BEING_PAID };
    const { api } = fakeApi(server);
    const detail = follow(payrollRunQuery(api, ORG, RUN.id));
    const runs = follow(payrollRunsQuery(api, ORG, { followPayments: true }));
    await vi.advanceTimersByTimeAsync(0);
    const people = () =>
      detail.data()?.payments.map((payment) => ({
        status: payment.status,
        receipts: payment.paymentReceipts.length,
      }));
    const before = { run: runs.data()?.[0]?.status, people: people() };

    // #when the last cash-out is paid
    server.run = PAID;
    await vi.advanceTimersByTimeAsync(5000);

    // #then
    expect({
      before,
      after: { run: runs.data()?.[0]?.status, people: people() },
    }).toEqual({
      before: {
        run: "paying",
        people: BEING_PAID.payments.map((_payment, at) => ({
          status: at === 0 ? "paying" : "paid",
          receipts: 0,
        })),
      },
      after: {
        run: "paid",
        people: BEING_PAID.payments.map((_payment, at) => ({
          status: "paid",
          receipts: at === 0 ? 2 : 0,
        })),
      },
    });
    detail.stop();
    runs.stop();
  });

  it("stops asking once the run is paid", async () => {
    // #given
    const server: Server = { run: BEING_PAID };
    const { api, asked } = fakeApi(server);
    const detail = follow(payrollRunQuery(api, ORG, RUN.id));
    await vi.advanceTimersByTimeAsync(5000);
    const whilePaying = asked.length;

    // #when
    server.run = PAID;
    await vi.advanceTimersByTimeAsync(5000);
    const settled = asked.length;
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({ whilePaying, settled, aMinuteLater: asked.length }).toEqual({
      whilePaying: 2,
      settled: 3,
      aMinuteLater: 3,
    });
    detail.stop();
  });

  it("doesn't ask again for a run that's paid, or for the sidebar's count", async () => {
    // #given
    const { api, asked } = fakeApi({ run: BEING_PAID });
    const sidebar = follow(
      payrollRunsQuery(api, ORG, { followPayments: false }),
    );
    const paid = fakeApi({ run: PAID });
    const detail = follow(payrollRunQuery(paid.api, ORG, RUN.id));
    await vi.advanceTimersByTimeAsync(0);

    // #when
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({ sidebar: asked.length, detail: paid.asked.length }).toEqual({
      sidebar: 1,
      detail: 1,
    });
    sidebar.stop();
    detail.stop();
  });
});
