import { describe, expect, it } from "vitest";

import type { ActiveWallet } from "@expendi-business/shared";

import { ApiError } from "~/lib/api";
import {
  limitsForPayee,
  limitsFromWallet,
  serverFieldIssues,
  smallestAmountHint,
  typedAmountProblem,
} from "./cash-out-limits";

const LIMITS = { minKesCents: 2000n, maxKesCents: 25000000n };
const NO_MINIMUM = { minKesCents: null, maxKesCents: 25000000n };

const withLimits = (
  minKesCents: string | null,
  maxKesCents: string | null,
): ActiveWallet => ({
  status: "active",
  address: "company.near",
  chain: "near",
  usdcBalance: "0",
  kesEquivalent: null,
  cashOutLimits: { minKesCents, maxKesCents },
});

describe("limitsFromWallet", () => {
  it("reads the wallet's limits, and none from an older API or a wallet not yet active", () => {
    // #then
    expect([
      limitsFromWallet(withLimits("2000", "25000000")),
      limitsFromWallet(withLimits(null, "25000000")),
      limitsFromWallet({ ...withLimits(null, null), cashOutLimits: undefined }),
      limitsFromWallet({ status: "creating" }),
      limitsFromWallet(undefined),
    ]).toEqual([LIMITS, NO_MINIMUM, null, null, null]);
  });
});

describe("limitsForPayee", () => {
  it("applies only to a payee paid by cash-out", () => {
    // #then
    expect([
      limitsForPayee("mpesa_phone", LIMITS),
      limitsForPayee("mpesa_till", LIMITS),
      limitsForPayee("mpesa_paybill", LIMITS),
      limitsForPayee("bank", LIMITS),
      limitsForPayee("usdc", LIMITS),
      limitsForPayee("outside", LIMITS),
      limitsForPayee(null, LIMITS),
      limitsForPayee(undefined, LIMITS),
      limitsForPayee("mpesa_phone", null),
    ]).toEqual([LIMITS, LIMITS, LIMITS, LIMITS, null, null, null, null, null]);
  });

  it("brings the hint when the payee chosen changes to one paid by cash-out, and takes it away after", () => {
    // #when
    const hints = (["usdc", "mpesa_till", "outside"] as const).map((method) =>
      smallestAmountHint(limitsForPayee(method, LIMITS)),
    );

    // #then
    expect(hints).toEqual([null, "Smallest amount: KES 20", null]);
  });
});

describe("smallestAmountHint", () => {
  it("states the minimum in whole shillings, and nothing while it's unknown", () => {
    // #then
    expect([
      smallestAmountHint(LIMITS),
      smallestAmountHint({ minKesCents: 150050n, maxKesCents: null }),
      smallestAmountHint(NO_MINIMUM),
      smallestAmountHint(null),
    ]).toEqual([
      "Smallest amount: KES 20",
      "Smallest amount: KES 1,500.50",
      null,
      null,
    ]);
  });
});

describe("typedAmountProblem", () => {
  it("gives the API's own message for an amount below the minimum or above the maximum", () => {
    // #then
    expect([
      typedAmountProblem("19", LIMITS),
      typedAmountProblem("250,000.01", LIMITS),
      typedAmountProblem("20", LIMITS),
      typedAmountProblem("250000", LIMITS),
    ]).toEqual([
      "The smallest amount that can be sent is KES 20.",
      "A single payment can send at most KES 250,000.00. Split it into smaller payments.",
      null,
      null,
    ]);
  });

  it("still holds to the maximum while the minimum is unknown", () => {
    // #then
    expect([
      typedAmountProblem("1", NO_MINIMUM),
      typedAmountProblem("300,000", NO_MINIMUM),
    ]).toEqual([
      null,
      "A single payment can send at most KES 250,000.00. Split it into smaller payments.",
    ]);
  });

  it("leaves a blank or unreadable amount, or a payee with no limits, alone", () => {
    // #then
    expect([
      typedAmountProblem("", LIMITS),
      typedAmountProblem("KES 5", LIMITS),
      typedAmountProblem("5", null),
    ]).toEqual([null, null, null]);
  });
});

describe("serverFieldIssues", () => {
  const FIELDS = { amountKes: "amount", payeeId: "payee" };
  const refused = (details: unknown, status = 400) =>
    new ApiError(
      status,
      "BadRequest",
      "The smallest amount that can be sent is KES 20.",
      details,
    );

  it("puts a 400 about the amount on the amount field", () => {
    // #then
    expect(serverFieldIssues(refused({ field: "amountKes" }), FIELDS)).toEqual([
      {
        path: ["amountKes"],
        message: "The smallest amount that can be sent is KES 20.",
      },
    ]);
  });

  it("leaves any other refusal to the form's error message", () => {
    // #then
    expect([
      serverFieldIssues(refused(undefined), FIELDS),
      serverFieldIssues(refused({ field: "elsewhere" }), FIELDS),
      serverFieldIssues(refused({ field: "amountKes" }, 409), FIELDS),
      serverFieldIssues(new Error("offline"), FIELDS),
    ]).toEqual([[], [], [], []]);
  });
});
