import type {
  AbiSchema,
  PolicyCondition,
  PolicyCreateParams,
} from "@privy-io/node/resources";

import { BASE_CHAIN_ID, USDC_BASE_ADDRESS } from "../chain/base.js";

/** Privy rejects rule names of 50 characters or more. */
export const USDC_TRANSFER_RULE_NAME = "usdc-base-transfer-capped";

const ERC20_TRANSFER_ABI: AbiSchema = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

/**
 * The only thing a company wallet can do: send USDC on Base, at most
 * `perTransactionMaxUsdc` per transaction, through gas-sponsored
 * `eth_sendTransaction`. Privy denies every method without a rule, so
 * approvals, other tokens, native ETH, other chains, message signing and
 * export are all refused. Proven in docs/decisions/privy-wallet-policies.md.
 */
export function companyWalletPolicyRules(
  perTransactionMaxUsdc: bigint,
): PolicyCreateParams.Rule[] {
  const conditions: PolicyCondition[] = [
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
    {
      field_source: "ethereum_calldata",
      field: "transfer.amount",
      abi: ERC20_TRANSFER_ABI,
      operator: "lte",
      value: perTransactionMaxUsdc.toString(),
    },
  ];
  return [
    {
      name: USDC_TRANSFER_RULE_NAME,
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions,
    },
  ];
}
