import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUSTOMERS,
  INVOICES,
} from "~/app/dev/preview/_harness/fixtures/invoices";
import { ApiError, createApiClient } from "~/lib/api";
import { invoiceCalls } from "./invoices-api";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const BASE = `https://api.example.com/organizations/${ORG}`;
const INVOICE = INVOICES[1];
const CUSTOMER = CUSTOMERS[0];
const DEPOSIT = {
  walletTransactionId: "00000000-0000-4000-8000-000000000501",
  amountUsdc: "1500000000",
  receivedAt: "2026-11-03T08:00:00.000Z",
  from: "0xabc",
  txHash: null,
};

type Fetcher = Mock<(url: string, init: RequestInit) => Promise<Response>>;

/** The API answers every route with `reply`, or a 204 for a DELETE with no body to give. */
function stubApi(reply: unknown, status = 200): Fetcher {
  const fetcher: Fetcher = vi.fn(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : Response.json({ success: true, data: reply }, { status }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function calls() {
  return invoiceCalls(
    createApiClient({
      baseUrl: "https://api.example.com",
      getAccessToken: () => Promise.resolve("token"),
    }),
    ORG,
  );
}

function sent(fetcher: Fetcher) {
  return fetcher.mock.calls.map(([url, { method, body }]) => [
    method,
    url,
    typeof body === "string" ? (JSON.parse(body) as unknown) : null,
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the invoice routes", () => {
  it("lists invoices with the status filter and fetches one, the next number and the deposits", async () => {
    // #given
    const fetcher = stubApi({
      invoices: [],
      deposits: [DEPOSIT],
      number: "INV-0006",
    });
    const api = calls();

    // #when
    await api.listInvoices(null);
    await api.listInvoices("overdue");
    await api.nextNumber();
    const deposits = await api.matchableDeposits("inv-1");

    // #then
    expect({ requests: sent(fetcher), deposits }).toEqual({
      requests: [
        ["GET", `${BASE}/invoices`, null],
        ["GET", `${BASE}/invoices?status=overdue`, null],
        ["GET", `${BASE}/invoices/next-number`, null],
        ["GET", `${BASE}/invoices/inv-1/matchable-deposits`, null],
      ],
      deposits: [DEPOSIT],
    });
  });

  it("creates a draft with a POST and replaces one with a PATCH", async () => {
    // #given
    const fetcher = stubApi(INVOICE);
    const request = {
      customerId: CUSTOMER?.id ?? "",
      number: "INV-0006",
      issueOn: "2026-11-06",
      terms: "net_30" as const,
      lines: [{ description: "Audit", quantity: "1", unitPriceCents: "10000" }],
    };

    // #when
    await calls().saveInvoice(null, request);
    await calls().saveInvoice("inv-1", request);

    // #then
    expect(sent(fetcher)).toEqual([
      ["POST", `${BASE}/invoices`, request],
      ["PATCH", `${BASE}/invoices/inv-1`, request],
    ]);
  });

  it("sends each lifecycle action to its own route", async () => {
    // #given
    const fetcher = stubApi(INVOICE);
    const api = calls();

    // #when
    await api.sendInvoice("inv-1");
    await api.voidInvoice("inv-1", { reason: "Wrong entity" });
    await api.markPaid("inv-1", { paidOn: "2026-11-05", reference: "KCB-1" });
    await api.matchDeposit("inv-1", DEPOSIT.walletTransactionId);
    await api.undoPayment("inv-1", "pay-1");

    // #then
    expect(sent(fetcher)).toEqual([
      ["POST", `${BASE}/invoices/inv-1/send`, {}],
      ["POST", `${BASE}/invoices/inv-1/void`, { reason: "Wrong entity" }],
      [
        "POST",
        `${BASE}/invoices/inv-1/mark-paid`,
        { paidOn: "2026-11-05", reference: "KCB-1" },
      ],
      [
        "POST",
        `${BASE}/invoices/inv-1/match`,
        { walletTransactionId: DEPOSIT.walletTransactionId },
      ],
      ["DELETE", `${BASE}/invoices/inv-1/payments/pay-1`, null],
    ]);
  });

  it("reminds, and deletes a draft that answers 204 with no body", async () => {
    // #given
    const remind = stubApi({ remindedAt: "2026-11-06T09:00:00.000Z" });

    // #when
    const reminded = await calls().remindInvoice("inv-1");
    const removal = stubApi(null, 204);
    await calls().deleteInvoice("inv-1");

    // #then
    expect({
      reminded,
      remindRequest: sent(remind),
      removal: sent(removal),
    }).toEqual({
      reminded: { remindedAt: "2026-11-06T09:00:00.000Z" },
      remindRequest: [["POST", `${BASE}/invoices/inv-1/remind`, {}]],
      removal: [["DELETE", `${BASE}/invoices/inv-1`, null]],
    });
  });

  it("creates, edits and lists customers, archived ones included on request", async () => {
    // #given
    const list = stubApi({ customers: [CUSTOMER] });

    // #when
    await calls().listCustomers(true);
    const created = stubApi(CUSTOMER);
    await calls().createCustomer({ name: "Acme", email: "a@acme.co.ke" });
    const updated = stubApi(CUSTOMER);
    await calls().updateCustomer("cus-1", { archived: true });

    // #then
    expect([...sent(list), ...sent(created), ...sent(updated)]).toEqual([
      ["GET", `${BASE}/customers?includeArchived=true`, null],
      ["POST", `${BASE}/customers`, { name: "Acme", email: "a@acme.co.ke" }],
      ["PATCH", `${BASE}/customers/cus-1`, { archived: true }],
    ]);
  });

  it("shows the API's message when an action is refused", async () => {
    // #given
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              success: false,
              error: {
                _tag: "Conflict",
                message: "A paid invoice can't be voided.",
              },
            },
            { status: 409 },
          ),
        ),
      ),
    );

    // #when
    const refused = calls().voidInvoice("inv-1", { reason: "Oops" });

    // #then
    await expect(refused).rejects.toEqual(
      new ApiError(409, "Conflict", "A paid invoice can't be voided."),
    );
  });
});
