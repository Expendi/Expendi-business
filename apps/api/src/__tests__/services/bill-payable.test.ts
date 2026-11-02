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
          amountKes: 250_000n,
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
      expect(result).toEqual(Either.right({ amountKes: 250_000n }));
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
});
