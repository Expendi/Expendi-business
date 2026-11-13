import { describe, expect, it } from "vitest";

import { nearTransactionUrl, payeeChainTransactionUrl } from "../explorer.js";

describe("nearTransactionUrl", () => {
  it("links the hash on Nearblocks exactly as given, case included", () => {
    expect(
      nearTransactionUrl("DHWqyb97sPMmW1MygAk1G1M6CWh5ADyanjTpBvPSdTz9"),
    ).toBe(
      "https://nearblocks.io/txns/DHWqyb97sPMmW1MygAk1G1M6CWh5ADyanjTpBvPSdTz9",
    );
  });
});

describe("payeeChainTransactionUrl", () => {
  const NEAR_HASH = "DHWqyb97sPMmW1MygAk1G1M6CWh5ADyanjTpBvPSdTz9";
  const BASE_HASH = `0x${"ab".repeat(32)}`;

  it("links a NEAR hash on Nearblocks exactly as given", () => {
    // #when
    const url = payeeChainTransactionUrl("near", NEAR_HASH);

    // #then
    expect(url).toBe(`https://nearblocks.io/txns/${NEAR_HASH}`);
  });

  it("links a Base hash on Basescan", () => {
    // #when
    const url = payeeChainTransactionUrl("base", BASE_HASH);

    // #then
    expect(url).toBe(`https://basescan.org/tx/${BASE_HASH}`);
  });

  it("links a Base value that isn't a transaction hash nowhere", () => {
    // #when
    const urls = [NEAR_HASH, "0x1234", `${BASE_HASH}/../x`].map((hash) =>
      payeeChainTransactionUrl("base", hash),
    );

    // #then
    expect(urls).toEqual([null, null, null]);
  });

  it("links a Solana signature nowhere, as no Solana explorer is known to be right", () => {
    // #when
    const url = payeeChainTransactionUrl("solana", NEAR_HASH);

    // #then
    expect(url).toBeNull();
  });
});
