import { describe, expect, it } from "vitest";

import type { TransactionReceipt } from "../../services/chain/base.js";
import { usdcTransfersIn } from "../../services/chain/base.js";
import {
  decodeGatewayOrderInfo,
  gatewayOrderInfoCalldata,
  gatewayRefundOrderId,
  ORDER_REFUNDED_TOPIC,
  PAYCREST_GATEWAY_BASE_ADDRESS,
} from "../../services/paycrest/gateway.js";
import { transferReceipt } from "../helpers/chain.js";
import { randomAddress } from "../helpers/fakes.js";
import {
  LIVE_GATEWAY_ORDER_ID,
  LIVE_GATEWAY_ORDER_INFO,
  LIVE_GATEWAY_REFUNDS,
} from "../helpers/gateway-receipts.js";

const ORDER_A = `0x${"a1".repeat(32)}`;
const ORDER_B = `0x${"b2".repeat(32)}`;

/** The order ID each USDC transfer in `receipt` refunds, in log order. */
function refundOrderIds(receipt: TransactionReceipt): (string | null)[] {
  return usdcTransfersIn(receipt).map((transfer) =>
    gatewayRefundOrderId(receipt, transfer),
  );
}

function orderRefundedLog(
  orderId: string,
  logIndex: number,
  address: string = PAYCREST_GATEWAY_BASE_ADDRESS,
) {
  return {
    address,
    topics: [ORDER_REFUNDED_TOPIC, orderId],
    data: `0x${"0".repeat(64)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

describe("gatewayRefundOrderId", () => {
  it("reads the order ID from the live refund of order c0bc8726", () => {
    // #when
    const ids = refundOrderIds(LIVE_GATEWAY_REFUNDS.c0bc8726);

    // #then
    expect(ids).toEqual([LIVE_GATEWAY_ORDER_ID]);
  });

  it("reads the order ID from the live refund of order 3e5a98fe", () => {
    // #when
    const ids = refundOrderIds(LIVE_GATEWAY_REFUNDS["3e5a98fe"]);

    // #then
    expect(ids).toEqual([
      "0x45e23184b57c7d29f01a3569fe29bf19a592d8dd056ef15c3ae45d6e884e820a",
    ]);
  });

  it("finds nothing when the Gateway's transfer has no OrderRefunded event", () => {
    // #given
    const [transfer] = LIVE_GATEWAY_REFUNDS.c0bc8726.logs;
    const receipt = { ...LIVE_GATEWAY_REFUNDS.c0bc8726, logs: [transfer] };

    // #when
    const ids = refundOrderIds(receipt);

    // #then
    expect(ids).toEqual([null]);
  });

  it("ignores USDC from anyone but the Gateway, even next to a refund event", () => {
    // #given
    const receipt = transferReceipt([{ to: randomAddress(), amount: 1n }]);
    const withEvent = {
      ...receipt,
      logs: [...receipt.logs, orderRefundedLog(ORDER_A, 1)],
    };

    // #when
    const ids = refundOrderIds(withEvent);

    // #then
    expect(ids).toEqual([null]);
  });

  it("ignores an OrderRefunded event emitted by any other contract", () => {
    // #given
    const receipt = transferReceipt([
      {
        from: PAYCREST_GATEWAY_BASE_ADDRESS,
        to: randomAddress(),
        amount: 1n,
      },
    ]);
    const spoofed = {
      ...receipt,
      logs: [...receipt.logs, orderRefundedLog(ORDER_A, 1, randomAddress())],
    };

    // #when
    const ids = refundOrderIds(spoofed);

    // #then
    expect(ids).toEqual([null]);
  });

  it("only takes the event emitted right after the transfer", () => {
    // #given an event earlier in the transaction, none after the transfer
    const receipt = transferReceipt([
      {
        from: PAYCREST_GATEWAY_BASE_ADDRESS,
        to: randomAddress(),
        amount: 1n,
        logIndex: 1,
      },
    ]);
    const eventFirst = {
      ...receipt,
      logs: [orderRefundedLog(ORDER_A, 0), ...receipt.logs],
    };

    // #when
    const ids = refundOrderIds(eventFirst);

    // #then
    expect(ids).toEqual([null]);
  });

  it("pairs each refund with its own event when one transaction refunds two orders with fees", () => {
    // #given refund() sends its fee to the treasury, then the refund, then emits
    const treasury = randomAddress();
    const wallet = randomAddress();
    const gateway = PAYCREST_GATEWAY_BASE_ADDRESS;
    const transfers = transferReceipt([
      { from: gateway, to: treasury, amount: 10n, logIndex: 0 },
      { from: gateway, to: wallet, amount: 500n, logIndex: 1 },
      { from: gateway, to: treasury, amount: 20n, logIndex: 3 },
      { from: gateway, to: wallet, amount: 700n, logIndex: 4 },
    ]);
    const [feeA, refundA, feeB, refundB] = transfers.logs;
    if (!feeA || !refundA || !feeB || !refundB) throw new Error("no logs");
    const receipt = {
      ...transfers,
      logs: [
        feeA,
        refundA,
        orderRefundedLog(ORDER_A, 2),
        feeB,
        refundB,
        orderRefundedLog(ORDER_B, 5),
      ],
    };

    // #when
    const ids = refundOrderIds(receipt);

    // #then
    expect(ids).toEqual([null, ORDER_A, null, ORDER_B]);
  });
});

describe("the Gateway's order record", () => {
  it("asks getOrderInfo for the order", () => {
    // #when
    const calldata = gatewayOrderInfoCalldata(LIVE_GATEWAY_ORDER_ID);

    // #then
    expect(calldata).toBe(
      "0x768c6ec0e5f673d6acc1f3f317e121ad1c35835e3d5fc512ef1187ee757b75b0ef7835b0",
    );
  });

  it("decodes the live record of order c0bc8726: created by its deposit address, refunding to the wallet", () => {
    // #when
    const info = decodeGatewayOrderInfo(LIVE_GATEWAY_ORDER_INFO);

    // #then
    expect(info).toEqual({
      sender: "0x2a1b84c7b8dc9fac24505ab87a41b21e654017bd",
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      refundAddress: "0x69685f698f002120af8185722a3c364a265bd0c3",
      amount: 777_062n,
    });
  });

  it("finds no order in the all-zero record the Gateway returns for an unknown ID", () => {
    expect(decodeGatewayOrderInfo(`0x${"0".repeat(640)}`)).toBeNull();
  });

  it("finds no order in a reply that isn't the Order struct", () => {
    expect(decodeGatewayOrderInfo("0x")).toBeNull();
  });
});
