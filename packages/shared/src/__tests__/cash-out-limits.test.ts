import { describe, expect, it } from "vitest";

import type { PayeeMethod } from "../payee.js";
import {
  cashOutAmountLimitsSchema,
  cashOutAmountProblem,
  paysByCashOut,
} from "../cash-out-limits.js";
import { PAYEE_METHODS } from "../payee.js";

const LIMITS = { minKesCents: 2_000n, maxKesCents: 25_000_000n };
const TOO_SMALL = "The smallest amount that can be sent is KES 20.";
const TOO_LARGE =
  "A single payment can send at most KES 250,000.00. Split it into smaller payments.";

describe("cashOutAmountProblem", () => {
  it.each([
    ["KES 19", 1_900n, TOO_SMALL],
    ["KES 19.50, sent as KES 20", 1_950n, null],
    ["KES 20", 2_000n, null],
    ["KES 250,000", 25_000_000n, null],
    ["KES 250,000.01, sent as KES 250,001", 25_000_001n, TOO_LARGE],
  ])("judges %s", (_name, amount, problem) => {
    expect(cashOutAmountProblem(amount, LIMITS)).toBe(problem);
  });

  it("states a minimum with thousands as whole shillings", () => {
    // #when
    const problem = cashOutAmountProblem(100n, {
      minKesCents: 123_400n,
      maxKesCents: null,
    });

    // #then
    expect(problem).toBe("The smallest amount that can be sent is KES 1,234.");
  });

  it("skips a limit it doesn't know", () => {
    expect(
      cashOutAmountProblem(100n, { minKesCents: null, maxKesCents: null }),
    ).toBeNull();
  });
});

describe("paysByCashOut", () => {
  it("is true for shilling methods only", () => {
    // #when
    const methods = [...PAYEE_METHODS, null].filter(
      (method: PayeeMethod | null) => paysByCashOut(method),
    );

    // #then
    expect(methods).toEqual([
      "mpesa_phone",
      "mpesa_till",
      "mpesa_paybill",
      "bank",
    ]);
  });
});

describe("cashOutAmountLimitsSchema", () => {
  it("takes cents as decimal strings, either one unknown", () => {
    expect(
      cashOutAmountLimitsSchema.parse({
        minKesCents: null,
        maxKesCents: "30000000",
      }),
    ).toEqual({ minKesCents: null, maxKesCents: "30000000" });
  });
});
