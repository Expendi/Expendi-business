import { describe, expect, it } from "vitest";

import { BASE_CHAIN_ID, USDC_BASE_ADDRESS } from "../../services/chain/base.js";
import { companyWalletPolicyRules } from "../../services/wallet/wallet-policy.js";

describe("companyWalletPolicyRules", () => {
  it("allows only capped USDC transfers on Base through eth_sendTransaction", () => {
    // #when
    const rules = companyWalletPolicyRules(5_000_000_000n);

    // #then
    expect(rules).toEqual([
      {
        name: "usdc-base-transfer-capped",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_transaction",
            field: "to",
            operator: "eq",
            value: USDC_BASE_ADDRESS,
          },
          {
            field_source: "ethereum_transaction",
            field: "chain_id",
            operator: "eq",
            value: String(BASE_CHAIN_ID),
          },
          expect.objectContaining({
            field_source: "ethereum_calldata",
            field: "transfer.amount",
            operator: "lte",
            value: "5000000000",
          }),
        ],
      },
    ]);
  });

  it("keeps rule names under Privy's 50-character limit", () => {
    const [rule] = companyWalletPolicyRules(1n);
    expect(rule?.name.length).toBeLessThan(50);
  });
});
