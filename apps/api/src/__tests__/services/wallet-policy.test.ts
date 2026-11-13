import { describe, expect, it } from "vitest";

import { BASE_CHAIN_ID, USDC_BASE_ADDRESS } from "../../services/chain/base.js";
import {
  companyWalletPolicyRules,
  treasuryWalletPolicyRules,
} from "../../services/wallet/wallet-policy.js";

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

describe("treasuryWalletPolicyRules", () => {
  const VAULT_ID = "ry2qt6co7rkpwkr5mqudloo4";

  it("allows Earn into and out of the one vault, and the capped USDC transfer, nothing else", () => {
    // #when
    const rules = treasuryWalletPolicyRules(VAULT_ID, 5_000_000_000n);

    // #then
    const earn = (method: "earn_deposit" | "earn_withdraw") => ({
      name: `${method.replace("_", "-")}-one-vault`,
      method,
      action: "ALLOW",
      conditions: [
        {
          field_source: "action_request_body",
          field: "vault_id",
          operator: "eq",
          value: VAULT_ID,
        },
      ],
    });
    expect(rules).toEqual([
      earn("earn_deposit"),
      earn("earn_withdraw"),
      ...companyWalletPolicyRules(5_000_000_000n),
    ]);
  });

  it("keeps every rule name under Privy's 50-character limit", () => {
    const names = treasuryWalletPolicyRules(VAULT_ID, 1n).map(
      (rule) => rule.name,
    );
    expect(names.every((name) => name.length < 50)).toBe(true);
  });
});
