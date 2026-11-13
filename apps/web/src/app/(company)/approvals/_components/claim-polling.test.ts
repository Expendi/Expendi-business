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

import type { Claim } from "@expendi-business/shared";

import type { CustomerApi } from "~/lib/customer-api";
import { paymentsSettled } from "~/lib/payment-poll";
import { payingClaimsQuery } from "./payment";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000aa";

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

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A reimbursement an admin approved, its payment on its way. */
const APPROVED: Claim = {
  id: id(1),
  status: "paying",
  merchant: "Naivas Supermarket",
  amountKes: "30000",
  spentOn: "2026-11-05",
  description: null,
  category: { id: id(2), name: "Office supplies" },
  mpesaCode: "SK41H7QZ2P",
  etimsInvoiceNumber: null,
  etimsSupplierPin: null,
  etimsQrPayload: null,
  etimsStatus: "none",
  rejectedReason: null,
  floatId: null,
  submittedBy: {
    membershipId: id(3),
    name: "Jane Wanjiku",
    email: "j@e.com",
    payoutPhoneConfirmed: true,
  },
  approvedAt: "2026-11-06T06:30:00.000Z",
  selfApproved: false,
  paidAt: null,
  paymentReceipts: [],
  canEdit: false,
  warnings: [],
  receiptCount: 1,
  createdAt: "2026-11-05T09:00:00.000Z",
  updatedAt: "2026-11-06T06:30:00.000Z",
};

function fakeApi(server: { paying: Claim[] }) {
  const asked: string[] = [];
  const api: Pick<CustomerApi, "listClaims"> = {
    listClaims: (_organizationId, query) => {
      asked.push(query.status);
      return Promise.resolve({ claims: server.paying, nextCursor: null });
    },
  };
  return { api, asked };
}

function follow(api: Pick<CustomerApi, "listClaims">) {
  const observer = new QueryObserver(
    new QueryClient(),
    payingClaimsQuery(api, ORGANIZATION_ID),
  );
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    paying: () => observer.getCurrentResult().data?.claims.length,
    stop: unsubscribe,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Approvals while approved claims are being paid", () => {
  it("asks about them every five seconds until none is left, then stops", async () => {
    // #given
    const server = { paying: [APPROVED] };
    const { api, asked } = fakeApi(server);
    const followed = follow(api);
    await vi.advanceTimersByTimeAsync(5000);
    const whilePaying = { asked: asked.length, paying: followed.paying() };

    // #when the reimbursement is paid
    server.paying = [];
    await vi.advanceTimersByTimeAsync(5000);
    const settled = { asked: asked.length, paying: followed.paying() };
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect({
      whilePaying,
      settled,
      aMinuteLater: asked.length,
      statuses: [...new Set(asked)],
      refreshesTheQueues: paymentsSettled(
        whilePaying.paying ?? 0,
        settled.paying ?? 0,
      ),
    }).toEqual({
      whilePaying: { asked: 2, paying: 1 },
      settled: { asked: 3, paying: 0 },
      aMinuteLater: 3,
      statuses: ["paying"],
      refreshesTheQueues: true,
    });
    followed.stop();
  });

  it("asks once when nothing is being paid", async () => {
    // #given
    const { api, asked } = fakeApi({ paying: [] });
    const followed = follow(api);

    // #when
    await vi.advanceTimersByTimeAsync(60_000);

    // #then
    expect(asked.length).toBe(1);
    followed.stop();
  });
});

describe("paymentsSettled", () => {
  it("is true only when fewer payments are on their way than before", () => {
    expect([
      paymentsSettled(2, 1),
      paymentsSettled(1, 0),
      paymentsSettled(0, 0),
      paymentsSettled(1, 1),
      paymentsSettled(0, 1),
    ]).toEqual([true, true, false, false, false]);
  });
});
