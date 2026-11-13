import { describe, expect, it } from "vitest";

import type {
  ActiveWallet,
  CashOutAmountLimits,
  PayeeMethod,
} from "@expendi-business/shared";

import type { TypedPayeeAmount } from "./cash-out-amount";
import { ApiError, apiErrorField } from "../../lib/api";
import {
  amountRefusal,
  cashOutAmountError,
  cashOutAmountHint,
  cashOutLimitsOf,
} from "./cash-out-amount";

const wallet: ActiveWallet = {
  status: "active",
  address: "expendi-co.near",
  chain: "near",
  usdcBalance: "100000000",
  kesEquivalent: null,
  cashOutLimits: { minKesCents: "2000", maxKesCents: "25000000" },
};

const limits: CashOutAmountLimits = {
  minKesCents: 2000n,
  maxKesCents: 25000000n,
};

function typed(
  amount: string,
  method: PayeeMethod | null = "mpesa_phone",
  overrides: Partial<TypedPayeeAmount> = {},
): TypedPayeeAmount {
  return { currency: "kes", amount, method, ...overrides };
}

describe("reading the cash-out limits from the wallet", () => {
  it("turns the stated cents into amounts", () => {
    // #then
    expect(cashOutLimitsOf(wallet)).toEqual(limits);
  });

  it("keeps an unknown minimum unknown", () => {
    // #when
    const read = cashOutLimitsOf({
      ...wallet,
      cashOutLimits: { minKesCents: null, maxKesCents: "25000000" },
    });

    // #then
    expect(read).toEqual({ minKesCents: null, maxKesCents: 25000000n });
  });

  it("has none from an API that doesn't send them, or before the wallet is active", () => {
    // #given
    const { cashOutLimits: _omitted, ...older } = wallet;

    // #then
    expect(cashOutLimitsOf(older)).toBeNull();
    expect(cashOutLimitsOf({ status: "creating" })).toBeNull();
    expect(cashOutLimitsOf(undefined)).toBeNull();
  });
});

describe("the amount field of a payee paid by cash-out", () => {
  it("states the smallest amount in whole shillings", () => {
    // #then
    expect(cashOutAmountHint(typed("5000"), limits)).toBe(
      "Smallest amount: KES 20",
    );
    expect(
      cashOutAmountHint(typed("", "bank"), { ...limits, minKesCents: 250000n }),
    ).toBe("Smallest amount: KES 2,500");
  });

  it("refuses an amount below the smallest, in the API's words", () => {
    // #then
    expect(cashOutAmountError(typed("19"), limits)).toBe(
      "The smallest amount that can be sent is KES 20.",
    );
  });

  it("refuses an amount above the largest, in the API's words", () => {
    // #then
    expect(cashOutAmountError(typed("250,000.01", "mpesa_till"), limits)).toBe(
      "A single payment can send at most KES 250,000.00. Split it into smaller payments.",
    );
  });

  it("takes an amount in range, judged in the whole shillings it sends", () => {
    // #then
    expect(
      ["19.01", "20", "15,000.00", "250000"].map((amount) =>
        cashOutAmountError(typed(amount, "mpesa_paybill"), limits),
      ),
    ).toEqual([null, null, null, null]);
  });

  it("leaves an amount that doesn't parse to the request's schema", () => {
    // #then
    expect(cashOutAmountError(typed("abc"), limits)).toBeNull();
  });

  it("checks only the largest while the smallest is unknown", () => {
    // #given
    const noMinimum = { ...limits, minKesCents: null };

    // #then
    expect(cashOutAmountHint(typed("5"), noMinimum)).toBeNull();
    expect(cashOutAmountError(typed("5"), noMinimum)).toBeNull();
    expect(cashOutAmountError(typed("300000"), noMinimum)).toBe(
      "A single payment can send at most KES 250,000.00. Split it into smaller payments.",
    );
  });
});

describe("amounts that aren't cash-outs", () => {
  it.each<[string, TypedPayeeAmount, CashOutAmountLimits | null]>([
    ["a payee paid in USDC", typed("5", "usdc", { currency: "usd" }), limits],
    ["a payee paid outside Expendi", typed("5", "outside"), limits],
    ["a payee with no payment details yet", typed("5", null), limits],
    ["limits the wallet doesn't state", typed("5"), null],
  ])("has no hint and no check for %s", (_case, amount, stated) => {
    // #then
    expect(cashOutAmountHint(amount, stated)).toBeNull();
    expect(cashOutAmountError(amount, stated)).toBeNull();
  });

  it("states the smallest amount before a variable bill's amount is entered, but checks nothing", () => {
    // #given
    const blank = typed("   ", "mpesa_phone");

    // #then
    expect(cashOutAmountHint(blank, limits)).toBe("Smallest amount: KES 20");
    expect(cashOutAmountError(blank, limits)).toBeNull();
  });
});

describe("a save the API refused for its amount", () => {
  it("names the field the form shows it on", () => {
    // #given
    const refused = new ApiError(
      400,
      "BadRequest",
      "The smallest amount that can be sent is KES 20.",
      { field: "amountKes" },
    );

    // #then
    expect(apiErrorField(refused)).toBe("amountKes");
    expect(amountRefusal(refused)).toBe(
      "The smallest amount that can be sent is KES 20.",
    );
  });

  it("names no field when the refusal doesn't", () => {
    // #then
    expect(apiErrorField(new ApiError(400, "BadRequest", "No."))).toBeNull();
    expect(
      apiErrorField(new ApiError(409, "Conflict", "Taken.", { claimId: "x" })),
    ).toBeNull();
    expect(apiErrorField(new Error("offline"))).toBeNull();
  });

  it("leaves a refusal for another field, or none, with the form's other errors", () => {
    // #then
    expect(
      amountRefusal(
        new ApiError(400, "BadRequest", "Pick a category.", {
          field: "categoryId",
        }),
      ),
    ).toBeNull();
    expect(amountRefusal(new ApiError(400, "BadRequest", "No."))).toBeNull();
    expect(amountRefusal(undefined)).toBeNull();
  });
});
