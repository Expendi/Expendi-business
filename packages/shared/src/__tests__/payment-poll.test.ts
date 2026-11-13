import { describe, expect, it } from "vitest";

import { BILL_STATUSES } from "../bills.js";
import { EXPENSE_STATUSES } from "../claims.js";
import { FLOAT_MOVEMENT_PHASES } from "../floats.js";
import {
  isPaymentInFlight,
  PAYMENT_POLL_MS,
  paymentPollInterval,
} from "../payment-poll.js";
import { PAYROLL_RUN_STATUSES } from "../payroll.js";
import { PAYOUT_STATUSES } from "../wallet-history.js";

describe("isPaymentInFlight", () => {
  it("counts only a bill being paid", () => {
    expect(
      BILL_STATUSES.filter((status) => isPaymentInFlight({ bills: [status] })),
    ).toEqual(["paying"]);
  });

  it("counts only a claim being paid", () => {
    expect(
      EXPENSE_STATUSES.filter((status) =>
        isPaymentInFlight({ claims: [status] }),
      ),
    ).toEqual(["paying"]);
  });

  it("counts only a payroll run being paid", () => {
    expect(
      PAYROLL_RUN_STATUSES.filter((status) =>
        isPaymentInFlight({ payrollRuns: [status] }),
      ),
    ).toEqual(["paying"]);
  });

  it("counts a float movement on its way, not one waiting for a passkey", () => {
    expect(
      FLOAT_MOVEMENT_PHASES.filter((phase) =>
        isPaymentInFlight({ floatMovements: [phase] }),
      ),
    ).toEqual(["on_its_way"]);
  });

  it("counts an approved payout until it's paid, failed or with staff", () => {
    expect(
      PAYOUT_STATUSES.filter((status) =>
        isPaymentInFlight({ payouts: [status] }),
      ),
    ).toEqual(["approved", "order_created", "funding", "paying"]);
  });

  it("counts a screen with one payment on its way among settled ones", () => {
    expect(
      isPaymentInFlight({
        bills: ["paid", "due"],
        payouts: ["paid", "funding"],
      }),
    ).toBe(true);
  });
});

describe("paymentPollInterval", () => {
  it("asks again every five seconds while a payment is on its way", () => {
    expect(paymentPollInterval({ bills: ["paid", "paying"] })).toBe(5000);
    expect(PAYMENT_POLL_MS).toBe(5000);
  });

  it("stops once nothing is on its way", () => {
    expect(
      paymentPollInterval({
        bills: ["paid", "payout_failed"],
        claims: ["paid"],
        payrollRuns: ["partly_failed"],
        floatMovements: ["awaiting_approval"],
        payouts: ["needs_review", "awaiting_approval"],
      }),
    ).toBe(false);
  });

  it("doesn't ask while there's nothing yet", () => {
    expect(paymentPollInterval({})).toBe(false);
    expect(paymentPollInterval({ bills: [] })).toBe(false);
  });
});
