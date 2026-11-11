import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SRC_DIR } from "../helpers/module-graph.js";

/** Source files, relative to `src/`, that ask Privy for a NEAR signer. */
function modulesAskingForANearSigner(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter(
      (file) =>
        file.endsWith(".ts") && !file.startsWith(`__tests__${path.sep}`),
    )
    .filter((file) =>
      readFileSync(path.join(SRC_DIR, file), "utf8").includes(".nearSigner("),
    )
    .map((file) => file.split(path.sep).join("/"))
    .sort();
}

describe("signing for NEAR wallets", () => {
  it("is asked for only by the capped company wallet send and the gas relayer", () => {
    // Privy checks nothing a NEAR wallet signs, so the API's cap holds only
    // while every company wallet signature goes through the one function
    // that checks it (docs/decisions/near-main-chain.md, "The spend cap").

    // #when
    const modules = modulesAskingForANearSigner();

    // #then
    expect(modules).toEqual([
      "services/chain/near-relayer.ts",
      "services/wallet/company-wallet-send.ts",
    ]);
  });
});
