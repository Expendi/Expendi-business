import { describe, expect, it } from "vitest";

import { nearTransactionUrl } from "../explorer.js";

describe("nearTransactionUrl", () => {
  it("links the hash on Nearblocks exactly as given, case included", () => {
    expect(
      nearTransactionUrl("DHWqyb97sPMmW1MygAk1G1M6CWh5ADyanjTpBvPSdTz9"),
    ).toBe(
      "https://nearblocks.io/txns/DHWqyb97sPMmW1MygAk1G1M6CWh5ADyanjTpBvPSdTz9",
    );
  });
});
