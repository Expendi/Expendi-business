import type { QueryKey, QueryObserverOptions } from "@tanstack/react-query";
import {
  focusManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Bill, BillDetail, BillsSummary } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import {
  BILL_DETAILS,
  BILLS_SUMMARY,
} from "~/app/dev/preview/_harness/fixtures/bills";
import { NO_BILL_FILTERS } from "./bill-list";
import { billListQuery, billQuery, billsSummaryQuery } from "./bills-api";

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
const TODAY = "2026-11-06";

const PAYING = BILL_DETAILS.find((bill) => bill.status === "paying");
if (!PAYING) throw new Error("No sample bill being paid");
const BEING_PAID: BillDetail = PAYING;
const PAID: BillDetail = {
  ...BEING_PAID,
  status: "paid",
  paidOn: TODAY,
  paymentReceipts: [{ kind: "mpesa", code: "UKDCW299LW" }],
};

const counts = (open: number, paying: number, history: number) => ({
  ...BILLS_SUMMARY,
  views: { open, paying, history },
});

/** What the API answers now; a test changes it as the payment moves on. */
interface Server {
  list: readonly Bill[];
  summary: BillsSummary;
  detail: BillDetail;
}

function fakeApi(server: Server): { api: ApiClient; asked: string[] } {
  const asked: string[] = [];
  const refuse = () => Promise.reject(new Error("Not asked in this test"));
  const api: ApiClient = {
    get: (path, schema) => {
      asked.push(path);
      const answer = path.includes("/summary?")
        ? server.summary
        : path.includes("/bills?")
          ? server.list
          : server.detail;
      return Promise.resolve(schema.parse(answer));
    },
    post: refuse,
    put: refuse,
    patch: refuse,
    delete: refuse,
  };
  return { api, asked };
}

/** Follows one query as a mounted screen would; returns its latest data. */
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
  vi.setSystemTime(new Date("2026-11-06T06:30:00Z"));
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("the Bills page while a bill is being paid", () => {
  it("moves the bill out of Being paid, and the tab counts, without a reload", async () => {
    // #given
    const server: Server = {
      list: [BEING_PAID],
      summary: counts(9, 1, 5),
      detail: BEING_PAID,
    };
    const { api } = fakeApi(server);
    const list = follow(
      billListQuery(api, ORG, "paying", NO_BILL_FILTERS, TODAY),
    );
    const summary = follow(billsSummaryQuery(api, ORG, {}));
    await vi.advanceTimersByTimeAsync(0);
    const before = {
      rows: list.data()?.length,
      tabs: summary.data()?.views,
    };

    // #when the cash-out is paid
    server.list = [];
    server.summary = counts(9, 0, 6);
    await vi.advanceTimersByTimeAsync(5000);

    // #then
    expect({
      before,
      after: { rows: list.data()?.length, tabs: summary.data()?.views },
    }).toEqual({
      before: { rows: 1, tabs: { open: 9, paying: 1, history: 5 } },
      after: { rows: 0, tabs: { open: 9, paying: 0, history: 6 } },
    });
    list.stop();
    summary.stop();
  });

  it("asks every five seconds until the bill settles, then stops", async () => {
    // #given
    const server: Server = {
      list: [BEING_PAID],
      summary: counts(9, 1, 5),
      detail: BEING_PAID,
    };
    const { api, asked } = fakeApi(server);
    const detail = follow(billQuery(api, ORG, BEING_PAID.id));
    await vi.advanceTimersByTimeAsync(0);

    // #when
    await vi.advanceTimersByTimeAsync(4999);
    const beforeFiveSeconds = asked.length;
    await vi.advanceTimersByTimeAsync(1);
    const atFiveSeconds = asked.length;
    server.detail = PAID;
    await vi.advanceTimersByTimeAsync(5000);
    const settled = asked.length;
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({
      beforeFiveSeconds,
      atFiveSeconds,
      settled,
      aMinuteLater: asked.length,
      status: detail.data()?.status,
      receipts: detail.data()?.paymentReceipts,
    }).toEqual({
      beforeFiveSeconds: 1,
      atFiveSeconds: 2,
      settled: 3,
      aMinuteLater: 3,
      status: "paid",
      receipts: [{ kind: "mpesa", code: "UKDCW299LW" }],
    });
    detail.stop();
  });

  it("doesn't ask again when nothing is being paid", async () => {
    // #given
    const server: Server = {
      list: [PAID],
      summary: counts(9, 0, 6),
      detail: PAID,
    };
    const { api, asked } = fakeApi(server);
    const followed = [
      follow(billListQuery(api, ORG, "history", NO_BILL_FILTERS, TODAY)),
      follow(billsSummaryQuery(api, ORG, {})),
      follow(billQuery(api, ORG, PAID.id)),
    ];
    await vi.advanceTimersByTimeAsync(0);

    // #when
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect(asked.length).toBe(3);
    for (const query of followed) query.stop();
  });

  it("doesn't ask while the tab is in the background", async () => {
    // #given
    const server: Server = {
      list: [BEING_PAID],
      summary: counts(9, 1, 5),
      detail: BEING_PAID,
    };
    const { api, asked } = fakeApi(server);
    const list = follow(
      billListQuery(api, ORG, "paying", NO_BILL_FILTERS, TODAY),
    );
    await vi.advanceTimersByTimeAsync(0);

    // #when
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(30_000);

    // #then
    expect(asked.length).toBe(1);
    list.stop();
  });
});
