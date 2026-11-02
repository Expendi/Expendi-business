import type { TransactionReceipt, UsdcTransfer } from "../chain/base.js";

/**
 * Paycrest's Gateway contract (its proxy) on Base, from the deployments
 * table in github.com/paycrest/contracts. Paycrest refunds a failed order
 * from here, not from the order's deposit address. A constant rather than
 * config, like USDC's, so an environment can't redirect refunds.
 */
export const PAYCREST_GATEWAY_BASE_ADDRESS =
  "0x30F6A8457F8E42371E204a9c103f2Bd42341dD0F";

/**
 * keccak256("OrderRefunded(uint256,bytes32)"), from IGateway.sol's
 * `event OrderRefunded(uint256 fee, bytes32 indexed orderId)`: topic 1 is
 * the on-chain order ID.
 */
export const ORDER_REFUNDED_TOPIC =
  "0x0736fe428e1747ca8d387c2e6fa1a31a0cde62d3a167c40a46ade59a3cdc828e";

/** A Gateway order ID: bytes32, lowercased. */
export const GATEWAY_ORDER_ID = /^0x[0-9a-f]{64}$/;

const GATEWAY = PAYCREST_GATEWAY_BASE_ADDRESS.toLowerCase();

export const isFromPaycrestGateway = (transfer: UsdcTransfer): boolean =>
  transfer.from === GATEWAY;

/**
 * The on-chain order a USDC transfer from the Gateway refunds.
 * `Gateway.refund()` sends the USDC and then emits OrderRefunded, so a
 * refund's event is the very next log in its receipt. Null for any other
 * transfer, or when that next log isn't the Gateway's OrderRefunded.
 */
export function gatewayRefundOrderId(
  receipt: TransactionReceipt,
  transfer: UsdcTransfer,
): string | null {
  if (!isFromPaycrestGateway(transfer)) return null;
  const event = receipt.logs.find(
    (log) => Number.parseInt(log.logIndex, 16) === transfer.logIndex + 1,
  );
  if (
    !event ||
    event.removed === true ||
    event.address.toLowerCase() !== GATEWAY ||
    event.topics.length !== 2 ||
    event.topics[0]?.toLowerCase() !== ORDER_REFUNDED_TOPIC
  ) {
    return null;
  }
  const orderId = event.topics[1]?.toLowerCase() ?? "";
  return GATEWAY_ORDER_ID.test(orderId) ? orderId : null;
}

/** keccak256("getOrderInfo(bytes32)")[0..4] */
const GET_ORDER_INFO_SELECTOR = "0x768c6ec0";

/** Calldata for the Gateway's `getOrderInfo(orderId)`. */
export function gatewayOrderInfoCalldata(orderId: string): string {
  if (!GATEWAY_ORDER_ID.test(orderId)) {
    throw new RangeError(`Not a Gateway order ID: ${orderId}`);
  }
  return `${GET_ORDER_INFO_SELECTOR}${orderId.slice(2)}`;
}

/** The parts of the Gateway's `Order` struct a refund is linked by. */
export interface GatewayOrderInfo {
  /**
   * Lowercased. The address that created the order: for a Sender API
   * order, the deposit address Paycrest gave us for it.
   */
  readonly sender: string;
  /** Lowercased. */
  readonly token: string;
  /** Lowercased. */
  readonly refundAddress: string;
  /** Token base units. */
  readonly amount: bigint;
}

const ORDER_STRUCT = /^0x[0-9a-f]{640}$/;
const ADDRESS_WORD = /^0{24}[0-9a-f]{40}$/;
const NO_ADDRESS = `0x${"0".repeat(40)}`;

/**
 * Decodes what `getOrderInfo` returns: the static `Order` struct, ten
 * words. Null for anything else, or for an order the Gateway doesn't have
 * (an all-zero struct).
 */
export function decodeGatewayOrderInfo(data: string): GatewayOrderInfo | null {
  const hex = data.toLowerCase();
  if (!ORDER_STRUCT.test(hex)) return null;
  const words = Array.from({ length: 10 }, (_, index) =>
    hex.slice(2 + index * 64, 2 + (index + 1) * 64),
  );
  const [sender, token, , , , , , refundAddress, , amount] = words;
  if (
    !sender ||
    !token ||
    !refundAddress ||
    !amount ||
    ![sender, token, refundAddress].every((word) => ADDRESS_WORD.test(word))
  ) {
    return null;
  }
  const info = {
    sender: `0x${sender.slice(24)}`,
    token: `0x${token.slice(24)}`,
    refundAddress: `0x${refundAddress.slice(24)}`,
    amount: BigInt(`0x${amount}`),
  };
  return info.sender === NO_ADDRESS ? null : info;
}
