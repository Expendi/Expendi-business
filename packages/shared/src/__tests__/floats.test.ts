import { describe, expect, it } from "vitest";

import {
  closeFloatRequestSchema,
  recordFloatReturnRequestSchema,
  recordFloatSpendingRequestSchema,
  splitFloatPurchase,
} from "../floats.js";

describe("splitFloatPurchase", () => {
  it.each([
    { amount: 30_000n, left: 100_000n, fromFloat: 30_000n, claimed: 0n },
    { amount: 100_000n, left: 100_000n, fromFloat: 100_000n, claimed: 0n },
    { amount: 100_001n, left: 100_000n, fromFloat: 100_000n, claimed: 1n },
    { amount: 45_000n, left: 30_000n, fromFloat: 30_000n, claimed: 15_000n },
    { amount: 20_000n, left: 0n, fromFloat: 0n, claimed: 20_000n },
    { amount: 20_000n, left: -5n, fromFloat: 0n, claimed: 20_000n },
  ])(
    "splits KES $amount with $left left into $fromFloat from the float and $claimed claimed",
    ({ amount, left, fromFloat, claimed }) => {
      // #when
      const split = splitFloatPurchase(amount, left);

      // #then
      expect(split).toEqual({ fromFloatKes: fromFloat, claimedKes: claimed });
    },
  );
});

describe("float request schemas", () => {
  it("takes spending with no receipt only as an empty list", () => {
    // #when
    const parsed = recordFloatSpendingRequestSchema.parse({
      merchant: "Kiosk",
      amountKes: "120",
      spentOn: "2026-10-15",
      categoryId: "6f1c1b8e-2f4a-4c55-9a39-5b0e7a1d2c3f",
      description: "Water",
      noReceiptReason: "Kiosk gave no receipt",
    });

    // #then
    expect({
      receipts: parsed.receiptFileIds,
      amount: parsed.amountKes,
    }).toEqual({ receipts: [], amount: 12_000n });
  });

  it("treats a blank return note as none", () => {
    // #when
    const parsed = recordFloatReturnRequestSchema.parse({
      amountKes: "500",
      note: "   ",
    });

    // #then
    expect(parsed.note).toBeNull();
  });

  it("needs a write-off reason of a few words", () => {
    // #when
    const result = closeFloatRequestSchema.safeParse({
      writeOffReason: "lost",
    });

    // #then
    expect(result.success).toBe(false);
  });
});
