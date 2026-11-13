import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Bill,
  BillPayment,
  BillPaymentResult,
} from "@expendi-business/shared";
import { BILL_PAYMENT_MAX_BILLS } from "@expendi-business/shared";

import type { BillPaymentRequest } from "./bill-payment";
import type { PasskeyAssertion } from "~/lib/passkeys";
import { createApiClient } from "~/lib/api";
import { approveWithPasskey } from "~/lib/approval";
import {
  billPreviewRows,
  confirmBillPayment,
  describeBillPaymentResult,
  holdFrom,
  isPayable,
  prepareBillPayment,
  toggleSelection,
  unpayableReason,
} from "./bill-payment";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const CHALLENGE = "00000000-0000-4000-8000-0000000000cc";
const API = "https://api.example.com";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeBill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: id(1),
    status: "due",
    payee: {
      id: id(50),
      name: "Kenya Power",
      kind: "supplier",
      method: "mpesa_paybill",
      archived: false,
    },
    overviewHeading: "transactions",
    category: { id: id(60), name: "Utilities" },
    variable: false,
    currency: "kes",
    amountKes: "1250000",
    amountUsdc: null,
    reference: "INV-204",
    notes: null,
    dueOn: "2026-11-02",
    recurringItemId: null,
    payrollRunId: null,
    adjustmentReason: null,
    paidOn: null,
    paidAt: null,
    markedPaidBy: null,
    paidOutsideNote: null,
    cancelledReason: null,
    cancelledAt: null,
    cancelledBy: null,
    payoutId: null,
    paymentReceipts: [],
    fileCount: 0,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    ...overrides,
  };
}

const payment: BillPayment = {
  challengeId: CHALLENGE,
  options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  bills: [
    {
      billId: id(1),
      payoutId: id(101),
      payeeName: "Kenya Power",
      paidTo: {
        method: "mpesa_paybill",
        label: "Paybill 888880, account A-17",
      },
      currency: "kes",
      billedKes: "1250050",
      receivesKes: "1250100",
      receivesUsdc: null,
      kesEquivalent: "1250100",
      rate: "128.68",
      usdc: "97148741",
      feeAllowanceUsdc: "971488",
      maxDebitUsdc: "98120229",
    },
    {
      billId: id(2),
      payoutId: id(102),
      payeeName: "Figma",
      paidTo: { method: "usdc", label: "0x1234…abcd" },
      currency: "usd",
      billedKes: null,
      receivesKes: null,
      receivesUsdc: "45000000",
      kesEquivalent: "579060",
      rate: "128.68",
      usdc: "45000000",
      feeAllowanceUsdc: "0",
      maxDebitUsdc: "45000000",
    },
  ],
  totals: {
    receivesKes: "1250100",
    receivesUsdc: "45000000",
    kesEquivalent: "1829160",
    usdc: "142148741",
    feeAllowanceUsdc: "971488",
    maxDebitUsdc: "143120229",
  },
  wallet: { availableUsdc: "500000000", shortfallUsdc: "0", topUpKes: null },
};

const paid: BillPaymentResult = {
  bills: payment.bills.map((preview) => ({
    billId: preview.billId,
    status: "paying",
    payout: { id: preview.payoutId, status: "paying", failureReason: null },
  })),
};

const hold = {
  reason: "payee_details_changed",
  payees: [
    {
      payeeId: id(51),
      name: "Figma",
      detailsChangedAt: "2026-11-02T06:00:00.000Z",
    },
  ],
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

function client() {
  return createApiClient({
    baseUrl: API,
    getAccessToken: () => Promise.resolve("token"),
  });
}

type Fetcher = Mock<(url: string, init: RequestInit) => Promise<Response>>;

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

describe("Pay all from the dashboard", () => {
  it("pays several due bills with one passkey, after the second confirmation a recently changed payee needs", async () => {
    // #given the API holds a payee changed today, then prepares, then pays
    const fetcher: Fetcher = vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith("/confirm")) {
        return Promise.resolve(Response.json({ success: true, data: paid }));
      }
      const body = JSON.parse(
        typeof init.body === "string" ? init.body : "{}",
      ) as BillPaymentRequest;
      return Promise.resolve(
        body.secondConfirmation
          ? Response.json({ success: true, data: payment }, { status: 201 })
          : Response.json(
              {
                success: false,
                error: {
                  _tag: "Conflict",
                  message: "Figma's payment details changed today.",
                  details: hold,
                },
              },
              { status: 409 },
            ),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const api = client();
    const sign = vi.fn(() => Promise.resolve(assertion));
    const billIds = [id(1), id(2)];
    const steps = {
      request: (request: BillPaymentRequest) =>
        prepareBillPayment(api, ORG, request),
      confirm: (challenge: BillPayment, signed: PasskeyAssertion) =>
        confirmBillPayment(api, ORG, challenge.challengeId, signed),
    };

    // #when the first preparation is held, the admin confirms, then signs once
    const first = await approveWithPasskey(
      steps,
      { billIds, retry: false, secondConfirmation: false },
      sign,
    ).catch((error: unknown) => error);
    const outcome = await approveWithPasskey(
      steps,
      { billIds, retry: false, secondConfirmation: true },
      sign,
    );

    // #then
    expect({
      held: holdFrom(first),
      outcome,
      signatures: sign.mock.calls.length,
      requests: sent(fetcher),
    }).toEqual({
      held: hold,
      outcome: { status: "approved", result: paid },
      signatures: 1,
      requests: [
        [
          "POST",
          `${API}/organizations/${ORG}/bills/payment`,
          { billIds, secondConfirmation: false },
        ],
        [
          "POST",
          `${API}/organizations/${ORG}/bills/payment`,
          { billIds, secondConfirmation: true },
        ],
        [
          "POST",
          `${API}/organizations/${ORG}/bills/payment/${CHALLENGE}/confirm`,
          { response: assertion },
        ],
      ],
    });
  });

  it("retries a failed bill through its own route", async () => {
    // #given
    const fetcher: Fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json({ success: true, data: payment }, { status: 201 }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    // #when
    await prepareBillPayment(client(), ORG, {
      billIds: [id(9)],
      retry: true,
      secondConfirmation: false,
    });

    // #then
    expect(sent(fetcher)).toEqual([
      [
        "POST",
        `${API}/organizations/${ORG}/bills/${id(9)}/retry`,
        { secondConfirmation: false },
      ],
    ]);
  });
});

describe("isPayable", () => {
  it("offers Pay only for an unpaid bill Expendi can pay, with its amount", () => {
    // #given
    const bills = {
      due: makeBill(),
      paid: makeBill({ status: "paid" }),
      variableWithoutAmount: makeBill({ variable: true, amountKes: null }),
      outside: makeBill({
        payee: { ...makeBill().payee, method: "outside" },
      }),
      salary: makeBill({ payrollRunId: id(70) }),
      methodNowUsdc: makeBill({
        payee: { ...makeBill().payee, method: "usdc" },
      }),
    };

    // #then
    expect(
      Object.fromEntries(
        Object.entries(bills).map(([name, bill]) => [
          name,
          [isPayable(bill), unpayableReason(bill)],
        ]),
      ),
    ).toEqual({
      due: [true, null],
      paid: [false, null],
      variableWithoutAmount: [false, "Enter the amount first."],
      outside: [false, "Paid outside Expendi: mark it paid."],
      salary: [false, "Paid with its payroll run."],
      methodNowUsdc: [
        false,
        "The payee's payment method changed: enter the amount again.",
      ],
    });
  });
});

describe("toggleSelection", () => {
  it(`selects at most ${String(BILL_PAYMENT_MAX_BILLS)} bills`, () => {
    // #given
    const full = Array.from({ length: BILL_PAYMENT_MAX_BILLS }, (_, n) =>
      id(n),
    );

    // #then
    expect([
      toggleSelection([id(1)], id(2)),
      toggleSelection([id(1), id(2)], id(1)),
      toggleSelection(full, id(99)),
    ]).toEqual([[id(1), id(2)], [id(2)], full]);
  });
});

describe("billPreviewRows", () => {
  it("shows a USD bill's exact USDC and its KES equivalent", () => {
    // #given
    const usd = payment.bills[1];
    if (!usd) throw new Error("no USD preview");

    // #then
    expect(billPreviewRows(usd)).toEqual([
      { label: "They receive", value: "45.00 USDC, exactly" },
      { label: "Paid to", value: "0x1234…abcd" },
      { label: "In KES, at today’s rate", value: "KES 5,790.60" },
      { label: "Cash-out fee, at most", value: "0.00 USDC" },
      { label: "Total, at most", value: "45.00 USDC" },
    ]);
  });
});

describe("describeBillPaymentResult", () => {
  it("names the one failed bill so it can be retried", () => {
    // #given
    const result: BillPaymentResult = {
      bills: [
        ...paid.bills.slice(0, 1),
        {
          billId: id(2),
          status: "payout_failed",
          payout: {
            id: id(102),
            status: "failed",
            failureReason: "Paycrest refunded the order.",
          },
        },
      ],
    };

    // #then
    expect(describeBillPaymentResult(result)).toMatchObject({
      outcome: "failed",
      failedBillIds: [id(2)],
      failureReason: "Paycrest refunded the order.",
    });
  });
});
