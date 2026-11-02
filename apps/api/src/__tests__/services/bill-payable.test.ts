import { randomUUID } from "node:crypto";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

import type { PayableBillCheck } from "../../services/bills/payable.js";
import { assertBillPayable } from "../../services/bills/payable.js";

function check(
  bill: Partial<PayableBillCheck["bill"]> = {},
  payee: Partial<PayableBillCheck["payee"]> = {},
) {
  return Effect.runSync(
    Effect.either(
      assertBillPayable({
        bill: {
          id: randomUUID(),
          status: "due",
          currency: "kes",
          amountKes: 250_000n,
          amountUsdc: null,
          reference: null,
          ...bill,
        },
        payee: {
          name: "Kenya Power",
          kind: "supplier",
          method: "mpesa_paybill",
          ...payee,
        },
      }),
    ),
  );
}

const reasonOf = (result: ReturnType<typeof check>) =>
  Either.isLeft(result) ? result.left.reason : null;

describe("assertBillPayable", () => {
  it.each(["upcoming", "due", "overdue", "payout_failed"] as const)(
    "lets a %s bill be paid, for its amount",
    (status) => {
      // #when
      const result = check({ status });

      // #then
      expect(result).toEqual(
        Either.right({ currency: "kes", amountKes: 250_000n }),
      );
    },
  );

  it.each(["paying", "paid", "paid_outside", "cancelled"] as const)(
    "refuses a %s bill",
    (status) => {
      // #when
      const result = check({ status });

      // #then
      expect(reasonOf(result)).toBe("not_unpaid");
    },
  );

  it("refuses a payee paid outside Expendi, whatever the bill", () => {
    // #when
    const result = check({}, { method: "outside", name: "Figma" });

    // #then
    expect(Either.isLeft(result) && result.left).toMatchObject({
      reason: "paid_outside_payee",
      message: expect.stringContaining(
        "Figma is paid outside Expendi",
      ) as unknown,
    });
  });

  it("refuses a variable bill until its amount is entered", () => {
    // #when
    const result = check({ amountKes: null });

    // #then
    expect(reasonOf(result)).toBe("no_amount");
  });

  it("refuses a statutory payment without its reference", () => {
    // #when
    const result = check({}, { kind: "statutory" });

    // #then
    expect(reasonOf(result)).toBe("no_reference");
  });

  it("pays a statutory payment once its reference is entered", () => {
    // #when
    const result = check(
      { reference: "PRN2026110012345" },
      { kind: "statutory" },
    );

    // #then
    expect(Either.isRight(result)).toBe(true);
  });

  it("pays a USD bill to a payee paid in USDC exactly its USDC", () => {
    // #when
    const result = check(
      { currency: "usd", amountKes: null, amountUsdc: 120_500_000n },
      { method: "usdc", name: "Vercel" },
    );

    // #then
    expect(result).toEqual(
      Either.right({ currency: "usd", amountUsdc: 120_500_000n }),
    );
  });

  it("refuses a variable USD bill until its amount is entered", () => {
    // #when
    const result = check(
      { currency: "usd", amountKes: null, amountUsdc: null },
      { method: "usdc" },
    );

    // #then
    expect(reasonOf(result)).toBe("no_amount");
  });

  it.each([
    ["a KES bill to a payee now paid in USDC", "kes", "usdc", "in USD"],
    ["a USD bill to a payee now paid by M-Pesa", "usd", "mpesa_till", "in KES"],
  ] as const)("refuses %s", (_, currency, method, asks) => {
    // #when
    const result = check(
      {
        currency,
        amountKes: currency === "kes" ? 250_000n : null,
        amountUsdc: currency === "usd" ? 2_000_000n : null,
      },
      { method },
    );

    // #then
    expect(Either.isLeft(result) && result.left).toMatchObject({
      reason: "currency_mismatch",
      message: expect.stringContaining(asks) as unknown,
    });
  });
});
