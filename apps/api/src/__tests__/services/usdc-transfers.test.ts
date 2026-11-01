import { describe, expect, it } from "vitest";

import { usdcTransfersIn } from "../../services/chain/base.js";
import { transferReceipt } from "../helpers/chain.js";
import { randomAddress } from "../helpers/fakes.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006";

describe("usdcTransfersIn", () => {
  it("reads sender, recipient, amount and log index from a USDC transfer", () => {
    // #given
    const to = randomAddress();
    const from = randomAddress();
    const receipt = transferReceipt([
      { to, from, amount: 20_000_000n, logIndex: 7 },
    ]);

    // #when
    const transfers = usdcTransfersIn(receipt);

    // #then
    expect(transfers).toEqual([
      {
        from,
        to,
        amount: 20_000_000n,
        logIndex: 7,
        blockNumber: 436n,
        txHash: receipt.transactionHash,
      },
    ]);
  });

  it("ignores transfers of any other token", () => {
    // #given
    const receipt = transferReceipt([
      { to: randomAddress(), amount: 1n, contract: WETH_BASE },
    ]);

    // #when
    const transfers = usdcTransfersIn(receipt);

    // #then
    expect(transfers).toEqual([]);
  });

  it("ignores a reverted transaction", () => {
    // #given
    const receipt = transferReceipt([{ to: randomAddress(), amount: 1n }], {
      status: "0x0",
    });

    // #when
    const transfers = usdcTransfersIn(receipt);

    // #then
    expect(transfers).toEqual([]);
  });

  it("ignores other USDC events, such as Approval", () => {
    // #given
    const receipt = transferReceipt([{ to: randomAddress(), amount: 1n }]);
    const [log] = receipt.logs;
    if (!log) throw new Error("receipt has no log");
    const approval = {
      ...receipt,
      logs: [
        {
          ...log,
          topics: [
            "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
            ...log.topics.slice(1),
          ],
        },
      ],
    };

    // #when
    const transfers = usdcTransfersIn(approval);

    // #then
    expect(transfers).toEqual([]);
  });

  it("ignores a log removed by a reorg", () => {
    // #given
    const receipt = transferReceipt([{ to: randomAddress(), amount: 1n }]);
    const removed = {
      ...receipt,
      logs: receipt.logs.map((log) => ({ ...log, removed: true })),
    };

    // #when
    const transfers = usdcTransfersIn(removed);

    // #then
    expect(transfers).toEqual([]);
  });

  it("matches the USDC contract whatever the address case", () => {
    // #given
    const receipt = transferReceipt([
      {
        to: randomAddress(),
        amount: 5n,
        contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    ]);

    // #when
    const transfers = usdcTransfersIn(receipt);

    // #then
    expect(transfers).toHaveLength(1);
  });

  it("keeps every USDC transfer in a multi-transfer transaction", () => {
    // #given
    const receipt = transferReceipt([
      { to: randomAddress(), amount: 1n, logIndex: 0 },
      { to: randomAddress(), amount: 1n, contract: WETH_BASE, logIndex: 1 },
      { to: randomAddress(), amount: 2n, logIndex: 2 },
    ]);

    // #when
    const transfers = usdcTransfersIn(receipt);

    // #then
    expect(transfers.map((transfer) => transfer.logIndex)).toEqual([0, 2]);
  });
});
