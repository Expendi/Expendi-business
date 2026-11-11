import { describe, expect, it } from "vitest";

import { intentQuoteResolvePrepareRequestSchema } from "../internal-intent-quotes.js";

const REASON = "Checked the deposit address on Nearblocks.";

describe("intentQuoteResolvePrepareRequestSchema", () => {
  it.each([["delivered"], ["refunded"], ["never_deposited"]])(
    "accepts the outcome %s with a reason",
    (outcome) => {
      // #when
      const parsed = intentQuoteResolvePrepareRequestSchema.safeParse({
        outcome,
        reason: `  ${REASON}  `,
      });

      // #then
      expect(parsed.success && parsed.data).toEqual({
        outcome,
        reason: REASON,
      });
    },
  );

  it.each([
    ["an outcome a payout takes", { outcome: "paid", reason: REASON }],
    ["no outcome", { reason: REASON }],
    ["no reason", { outcome: "delivered" }],
    ["a reason too short to say why", { outcome: "refunded", reason: "ok" }],
  ])("refuses %s", (_case, body) => {
    // #when
    const parsed = intentQuoteResolvePrepareRequestSchema.safeParse(body);

    // #then
    expect(parsed.success).toBe(false);
  });
});
