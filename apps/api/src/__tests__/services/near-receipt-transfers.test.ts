import { describe, expect, it } from "vitest";

import {
  nearUsdcReceiptTransfersIn,
  nearUsdcTransfersIn,
} from "../../services/chain/near.js";
import {
  ftTransferLog,
  nearOutcome,
  randomNearAccount,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";

const transfersIn = (
  outcome: Parameters<typeof nearUsdcReceiptTransfersIn>[0],
) => nearUsdcReceiptTransfersIn(outcome, TEST_USDC_CONTRACT);

describe("nearUsdcReceiptTransfersIn", () => {
  it("places a transfer by its receipt, the log's place in that receipt and its place in the event", () => {
    // #given
    const from = randomNearAccount();
    const first = randomNearAccount();
    const second = randomNearAccount();
    const outcome = nearOutcome([
      { executorId: "relayer.near", logs: ["one", "two", "three"] },
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          "not an event",
          ftTransferLog([
            { from, to: first, amount: 5n },
            { from, to: second, amount: 7n },
          ]),
        ],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    const receiptId = outcome.receipts[1]?.receiptId;
    expect(transfers).toEqual([
      {
        from,
        to: first,
        amount: 5n,
        receiptId,
        receiptLogIndex: 1,
        transferIndex: 0,
        blockHeight: outcome.blockHeight,
        txHash: outcome.txHash,
      },
      {
        from,
        to: second,
        amount: 7n,
        receiptId,
        receiptLogIndex: 1,
        transferIndex: 1,
        blockHeight: outcome.blockHeight,
        txHash: outcome.txHash,
      },
    ]);
  });

  it("names a transfer the same whatever other receipts the transaction has", () => {
    // #given
    const entry = { from: randomNearAccount(), to: "payee.near", amount: 9n };
    const usdc = {
      executorId: TEST_USDC_CONTRACT,
      logs: [ftTransferLog([entry])],
    };
    const alone = transfersIn(nearOutcome([usdc]));
    const amongOthers = transfersIn(
      nearOutcome([
        { executorId: "intents.near", logs: ["a", "b"] },
        usdc,
        { executorId: "intents.near", logs: ["c"] },
      ]),
    );

    // #then
    expect(
      [alone, amongOthers].map(([transfer]) => [
        transfer?.receiptLogIndex,
        transfer?.transferIndex,
      ]),
    ).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("ignores the same event logged by any contract but USDC", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: "usdc.imposter.testnet",
        logs: [
          ftTransferLog([
            { from: randomNearAccount(), to: "payee.near", amount: 1_000n },
          ]),
        ],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it("ignores a USDC receipt that failed: its transfer was rolled back", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: TEST_USDC_CONTRACT,
        succeeded: false,
        logs: [
          ftTransferLog([
            { from: randomNearAccount(), to: "payee.near", amount: 1_000n },
          ]),
        ],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it("finds exactly the transfers nearUsdcTransfersIn finds", () => {
    // #given
    const from = randomNearAccount();
    const outcome = nearOutcome([
      {
        executorId: "other.near",
        logs: [ftTransferLog([{ from, to: "x.near", amount: 1n }])],
      },
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          ftTransferLog([{ from, to: "a.near", amount: 2n }]),
          ftTransferLog([
            { from, to: "b.near", amount: 3n },
            { from, to: "NotAnAccount", amount: 4n },
            { from, to: "c.near", amount: 0n },
          ]),
        ],
      },
    ]);
    const summary = (transfer: { to: string; amount: bigint }) => [
      transfer.to,
      transfer.amount,
    ];

    // #when
    const placed = transfersIn(outcome).map(summary);

    // #then
    expect(placed).toEqual(
      nearUsdcTransfersIn(outcome, TEST_USDC_CONTRACT).map(summary),
    );
  });
});
