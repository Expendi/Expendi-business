import { describe, expect, it } from "vitest";

import { basescanAddressUrl, transactionUrl } from "./explorer";

describe("explorer links", () => {
  it("links a Base address and a Base transaction to Basescan", () => {
    // #then
    expect([basescanAddressUrl("0xabc"), transactionUrl("0x123")]).toEqual([
      "https://basescan.org/address/0xabc",
      "https://basescan.org/tx/0x123",
    ]);
  });

  it("links a NEAR transaction, told apart by its shape, to NEAR Blocks", () => {
    // #then
    expect(transactionUrl("9ZkQ3dDmEoVvTyrJ")).toBe(
      "https://nearblocks.io/txns/9ZkQ3dDmEoVvTyrJ",
    );
  });
});
