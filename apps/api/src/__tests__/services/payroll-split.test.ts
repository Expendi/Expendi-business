import { describe, expect, it } from "vitest";

import type { PayablePayrollPayment } from "../../services/payroll/payable.js";
import { payrollPayoutRequests } from "../../services/payroll/payable.js";
import {
  MAX_KES_PER_ORDER_CENTS,
  salaryParts,
} from "../../services/payroll/split.js";

const sum = (parts: readonly bigint[]) =>
  parts.reduce((total, part) => total + part, 0n);

describe("salaryParts", () => {
  it.each([
    ["KES 50,000", 5_000_000n, [5_000_000n]],
    ["exactly KES 300,000", 30_000_000n, [30_000_000n]],
    ["KES 300,000.01", 30_000_001n, [15_000_100n, 14_999_901n]],
    ["KES 500,000.50", 50_000_050n, [25_000_100n, 24_999_950n]],
    ["KES 900,000", 90_000_000n, [30_000_000n, 30_000_000n, 30_000_000n]],
  ])("splits %s into as few orders as fit", (_, amount, expected) => {
    // #when
    const parts = salaryParts(amount);

    // #then
    expect(parts).toEqual(expected);
  });

  it.each([30_000_099n, 59_999_999n, 123_456_789n, 1_000_000_000n])(
    "keeps every order of %s KES cents under the maximum, adding up exactly",
    (amount) => {
      // #when
      const parts = salaryParts(amount);

      // #then
      expect({
        total: sum(parts),
        withinMax: parts.every(
          (part) => part > 0n && part <= MAX_KES_PER_ORDER_CENTS,
        ),
        wholeShillingsButTheLast: parts
          .slice(0, -1)
          .every((part) => part % 100n === 0n),
      }).toEqual({
        total: amount,
        withinMax: true,
        wholeShillingsButTheLast: true,
      });
    },
  );
});

describe("payrollPayoutRequests for a salary above the largest order", () => {
  const payment: PayablePayrollPayment = {
    billId: "00000000-0000-4000-8000-000000000001",
    payeeId: "00000000-0000-4000-8000-000000000002",
    payeeName: "Dana Kimani",
    amountKesCents: 50_000_050n,
    recipient: {
      method: "mpesa_phone",
      phone: "+254712345678",
      accountName: "Dana Kimani",
    },
  };
  const runId = "00000000-0000-4000-8000-000000000003";

  it("asks for one payout per part, each keyed to its part", () => {
    // #when
    const requests = payrollPayoutRequests(runId, [payment]);

    // #then
    expect(
      requests.map((request) => [
        request.subjectPart,
        request.amountKesCents,
        request.idempotencyKey,
      ]),
    ).toEqual([
      [1, 25_000_100n, `payroll:${payment.billId}:1:part1`],
      [2, 24_999_950n, `payroll:${payment.billId}:1:part2`],
    ]);
  });

  it("leaves out the parts already paid, and keys a retry's attempt", () => {
    // #when
    const requests = payrollPayoutRequests(runId, [payment], {
      paidParts: () => new Set([1]),
      attemptOf: (_, part) => (part === 2 ? 2 : 1),
    });

    // #then
    expect(
      requests.map((request) => [request.subjectPart, request.idempotencyKey]),
    ).toEqual([[2, `payroll:${payment.billId}:2:part2`]]);
  });
});
