import type { TransactionReceipt } from "../../services/chain/base.js";
import type { GatewayOrderInfo } from "../../services/paycrest/gateway.js";
import { USDC_BASE_ADDRESS } from "../../services/chain/base.js";
import {
  gatewayOrderInfoCalldata,
  PAYCREST_GATEWAY_BASE_ADDRESS,
} from "../../services/paycrest/gateway.js";
import { randomTxHash } from "./chain.js";
import { callKey } from "./fakes.js";

/**
 * The two live refunds from Checkpoint B (2026-11-01), as Base's public RPC
 * (`eth_getTransactionReceipt` on mainnet.base.org) returns them, trimmed to
 * the fields we read. Each is Paycrest's Gateway sending USDC back to the
 * test company's wallet, then emitting OrderRefunded for the on-chain order.
 */
export const LIVE_GATEWAY_REFUNDS = {
  /** Order c0bc8726-30a8-4638-9f4f-4c5e8bc2ab02: 0.777062 USDC. */
  c0bc8726: {
    transactionHash:
      "0x2cf51a57c72d3a1e9a8c4e4797e9aa97d573f23b8489a7c5d37adc44ae61240d",
    status: "0x1",
    blockNumber: "0x32eaf26",
    logs: [
      {
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x00000000000000000000000030f6a8457f8e42371e204a9c103f2bd42341dd0f",
          "0x00000000000000000000000069685f698f002120af8185722a3c364a265bd0c3",
        ],
        data: "0x00000000000000000000000000000000000000000000000000000000000bdb66",
        logIndex: "0x2f",
        removed: false,
      },
      {
        address: "0x30f6a8457f8e42371e204a9c103f2bd42341dd0f",
        topics: [
          "0x0736fe428e1747ca8d387c2e6fa1a31a0cde62d3a167c40a46ade59a3cdc828e",
          "0xe5f673d6acc1f3f317e121ad1c35835e3d5fc512ef1187ee757b75b0ef7835b0",
        ],
        data: "0x0000000000000000000000000000000000000000000000000000000000000000",
        logIndex: "0x30",
        removed: false,
      },
    ],
  },
  /** Order 3e5a98fe-2e43-4b2a-95cc-31cb92f9a143: 0.50509 USDC. */
  "3e5a98fe": {
    transactionHash:
      "0x0a18a3a28f0385de37b237e79472bb099f2eada6612659b3322f2824c64678fd",
    status: "0x1",
    blockNumber: "0x32eb412",
    logs: [
      {
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x00000000000000000000000030f6a8457f8e42371e204a9c103f2bd42341dd0f",
          "0x00000000000000000000000069685f698f002120af8185722a3c364a265bd0c3",
        ],
        data: "0x000000000000000000000000000000000000000000000000000000000007b502",
        logIndex: "0x3e5",
        removed: false,
      },
      {
        address: "0x30f6a8457f8e42371e204a9c103f2bd42341dd0f",
        topics: [
          "0x0736fe428e1747ca8d387c2e6fa1a31a0cde62d3a167c40a46ade59a3cdc828e",
          "0x45e23184b57c7d29f01a3569fe29bf19a592d8dd056ef15c3ae45d6e884e820a",
        ],
        data: "0x0000000000000000000000000000000000000000000000000000000000000000",
        logIndex: "0x3e6",
        removed: false,
      },
    ],
  },
} as const satisfies Record<string, TransactionReceipt>;

/** The Gateway order ID of the live refund of order c0bc8726. */
export const LIVE_GATEWAY_ORDER_ID =
  "0xe5f673d6acc1f3f317e121ad1c35835e3d5fc512ef1187ee757b75b0ef7835b0";

const word = (value: bigint): string =>
  `0x${value.toString(16).padStart(64, "0")}`;

export interface GatewayRefundInput {
  /** The company wallet the refund goes to. */
  readonly to: string;
  readonly amount: bigint;
  readonly orderId: string;
  /** Leave out the OrderRefunded event, as if the Gateway hadn't emitted it. */
  readonly withoutEvent?: boolean;
  readonly txHash?: string;
}

/**
 * The live c0bc8726 refund re-addressed to a test wallet, with its own hash
 * (the ledger is unique per transfer log across every company).
 */
export function gatewayRefundReceipt(
  input: GatewayRefundInput,
): TransactionReceipt {
  const [transfer, refunded] = LIVE_GATEWAY_REFUNDS.c0bc8726.logs;
  return {
    ...LIVE_GATEWAY_REFUNDS.c0bc8726,
    transactionHash: input.txHash ?? randomTxHash(),
    logs: [
      {
        ...transfer,
        topics: [
          transfer.topics[0],
          transfer.topics[1],
          `0x${input.to.slice(2).toLowerCase().padStart(64, "0")}`,
        ],
        data: word(input.amount),
      },
      ...(input.withoutEvent
        ? []
        : [{ ...refunded, topics: [refunded.topics[0], input.orderId] }]),
    ],
  };
}

/**
 * What the Gateway's `getOrderInfo` returned for that order on Base after
 * the refund (`eth_call` on mainnet.base.org): sender (the order's deposit
 * address), token, sender-fee recipient, sender fee, protocol fee,
 * fulfilled, refunded, refund address (the company wallet), current BPS,
 * amount.
 */
export const LIVE_GATEWAY_ORDER_INFO = `0x${[
  "0000000000000000000000002a1b84c7b8dc9fac24505ab87a41b21e654017bd",
  "000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "00000000000000000000000027e5cf811c4294211367c69a8c305bcb9a79feba",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000f2d",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000001",
  "00000000000000000000000069685f698f002120af8185722a3c364a265bd0c3",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "00000000000000000000000000000000000000000000000000000000000bdb66",
].join("")}`;

const addressWord = (address: string): string =>
  address.slice(2).toLowerCase().padStart(64, "0");

/** `getOrderInfo`'s return data for an order with these details. */
export function gatewayOrderInfoResult(info: GatewayOrderInfo): string {
  const words = [
    addressWord(info.sender),
    addressWord(info.token),
    addressWord(`0x${"27".repeat(20)}`),
    "0".repeat(64),
    3885n.toString(16).padStart(64, "0"),
    "0".repeat(64),
    "1".padStart(64, "0"),
    addressWord(info.refundAddress),
    "0".repeat(64),
    info.amount.toString(16).padStart(64, "0"),
  ];
  return `0x${words.join("")}`;
}

/** Makes the fake RPC's Gateway hold `orderId` with these details. */
export function setGatewayOrder(
  callResults: Map<string, string>,
  orderId: string,
  info: Omit<GatewayOrderInfo, "token"> & { readonly token?: string },
): void {
  callResults.set(
    callKey(PAYCREST_GATEWAY_BASE_ADDRESS, gatewayOrderInfoCalldata(orderId)),
    gatewayOrderInfoResult({ token: USDC_BASE_ADDRESS, ...info }),
  );
}
