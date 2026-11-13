import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Expense } from "@expendi-business/shared";

import type { CustomerApi, ExpenseListParams } from "~/lib/customer-api";
import { paymentsSettled } from "~/lib/payment-poll";
import { claimsBeingPaid, expenseListQuery } from "./expense-list";

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
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const LIST_QUERY: ExpenseListParams = {
  sort: "date",
  dir: "desc",
  limit: 50,
};

/** A reimbursement an admin approved, its payment on its way. */
const BEING_PAID: Expense = {
  id: id(1),
  kind: "claim",
  listKind: "claim",
  status: "paying",
  source: "app",
  overviewHeading: "transactions",
  merchant: "Naivas Supermarket",
  amountKes: "30000",
  spentOn: "2026-11-05",
  description: "Printer paper",
  category: { id: id(2), name: "Office supplies" },
  member: { membershipId: id(3), name: "Jane Wanjiku", email: "j@e.com" },
  mpesaCode: null,
  etimsStatus: "none",
  etimsInvoiceNumber: null,
  etimsSupplierPin: null,
  warnings: [],
  receiptCount: 1,
  noReceipt: false,
  noReceiptReason: null,
  rejectedReason: null,
  selfApproved: false,
  approvedAt: "2026-11-06T06:30:00.000Z",
  paidAt: null,
  paymentReceipts: [],
  floatId: null,
  overspendClaimId: null,
  bill: null,
  paidFromAccount: null,
  createdAt: "2026-11-05T09:00:00.000Z",
};

const PAID: Expense = {
  ...BEING_PAID,
  status: "paid",
  paidAt: "2026-11-06T06:31:00.000Z",
  paymentReceipts: [{ kind: "mpesa", code: "UKDCW299LW" }],
};

function fakeApi(server: { rows: Expense[] }) {
  const asked: ExpenseListParams[] = [];
  const api: Pick<CustomerApi, "listExpenses"> = {
    listExpenses: (_organizationId, query) => {
      asked.push(query);
      return Promise.resolve({ expenses: server.rows, nextCursor: null });
    },
  };
  return { api, asked };
}

function follow(api: Pick<CustomerApi, "listExpenses">) {
  const observer = new InfiniteQueryObserver(
    new QueryClient(),
    expenseListQuery(api, ORG, LIST_QUERY),
  );
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    beingPaid: () => claimsBeingPaid(observer.getCurrentResult().data),
    status: () =>
      observer.getCurrentResult().data?.pages[0]?.expenses[0]?.status,
    stop: unsubscribe,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Expenses list while a reimbursement on it is being paid", () => {
  it("asks every five seconds until it's paid, then stops", async () => {
    // #given
    const server = { rows: [BEING_PAID] };
    const { api, asked } = fakeApi(server);
    const followed = follow(api);
    await vi.advanceTimersByTimeAsync(5000);
    const whilePaying = {
      asked: asked.length,
      beingPaid: followed.beingPaid(),
    };

    // #when the reimbursement is paid
    server.rows = [PAID];
    await vi.advanceTimersByTimeAsync(5000);
    const settled = { asked: asked.length, beingPaid: followed.beingPaid() };
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({
      whilePaying,
      settled,
      aMinuteLater: asked.length,
      status: followed.status(),
      refreshesTheTotals: paymentsSettled(
        whilePaying.beingPaid,
        settled.beingPaid,
      ),
    }).toEqual({
      whilePaying: { asked: 2, beingPaid: 1 },
      settled: { asked: 3, beingPaid: 0 },
      aMinuteLater: 3,
      status: "paid",
      refreshesTheTotals: true,
    });
    followed.stop();
  });

  it("asks once when nothing on it is being paid", async () => {
    // #given
    const { api, asked } = fakeApi({ rows: [PAID] });
    const followed = follow(api);

    // #when
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect(asked.length).toBe(1);
    followed.stop();
  });
});
