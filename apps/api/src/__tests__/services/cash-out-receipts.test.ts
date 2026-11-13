import { describe, expect, it } from "vitest";

import type { PayoutReceiptFacts } from "../../services/payout/receipts.js";
import {
  cashOutReceiptOf,
  cashOutReceiptsOf,
} from "../../services/payout/receipts.js";

const paid = (facts: Partial<PayoutReceiptFacts> = {}): PayoutReceiptFacts => ({
  provider: "pretium",
  method: "mpesa_phone",
  status: "paid",
  providerReference: "UKDCW299LW",
  ...facts,
});

describe("cashOutReceiptOf", () => {
  it.each<[PayoutReceiptFacts["method"], "mpesa" | "bank"]>([
    ["mpesa_phone", "mpesa"],
    ["mpesa_till", "mpesa"],
    ["mpesa_paybill", "mpesa"],
    ["bank", "bank"],
  ])("calls a paid %s cash-out's receipt %s", (method, kind) => {
    expect(cashOutReceiptOf(paid({ method }))).toEqual({
      kind,
      code: "UKDCW299LW",
    });
  });

  it.each<PayoutReceiptFacts["provider"]>(["paycrest", "pretium"])(
    "shows the receipt whichever provider (%s) paid it",
    (provider) => {
      expect(cashOutReceiptOf(paid({ provider }))?.code).toBe("UKDCW299LW");
    },
  );

  it.each<PayoutReceiptFacts["status"]>([
    "awaiting_approval",
    "approved",
    "order_created",
    "funding",
    "paying",
    "failed",
    "needs_review",
  ])("shows none for a %s payout", (status) => {
    expect(cashOutReceiptOf(paid({ status }))).toBeNull();
  });

  it.each([null, ""])("shows none for a paid receipt of %j", (reference) => {
    expect(cashOutReceiptOf(paid({ providerReference: reference }))).toBeNull();
  });

  it("never shows a USDC payout's transaction hash", () => {
    // #given
    const usdc = paid({
      provider: "onchain",
      method: "usdc",
      providerReference: `0x${"ab".repeat(32)}`,
    });

    // #when
    const receipt = cashOutReceiptOf(usdc);

    // #then
    expect(receipt).toBeNull();
  });

  it.each<[string, Partial<PayoutReceiptFacts>]>([
    ["sent on chain", { provider: "onchain" }],
    ["paid in USDC", { method: "usdc" }],
  ])("shows none for a payout %s, on either sign alone", (_name, facts) => {
    expect(cashOutReceiptOf(paid(facts))).toBeNull();
  });
});

describe("cashOutReceiptsOf", () => {
  it("keeps the paid cash-outs' receipts, in the order given", () => {
    // #given
    const payouts = [
      paid({ providerReference: "UKD1" }),
      paid({ status: "failed", providerReference: "UKDX" }),
      paid({ provider: "onchain", method: "usdc", providerReference: "0x1" }),
      paid({ method: "bank", providerReference: "FT2" }),
    ];

    // #when
    const receipts = cashOutReceiptsOf(payouts);

    // #then
    expect(receipts).toEqual([
      { kind: "mpesa", code: "UKD1" },
      { kind: "bank", code: "FT2" },
    ]);
  });
});
