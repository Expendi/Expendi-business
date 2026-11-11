import { describe, expect, it } from "vitest";

import {
  intentsTokenTransferAction,
  LOG_INDEX_STRIDE,
  nearIntentsTransfersIn,
  nearUsdcTransfersIn,
} from "../../services/chain/near.js";
import {
  ftTransferLog,
  mtTransferLog,
  nearOutcome,
  randomNearAccount,
  TEST_INTENTS_CONTRACT,
  TEST_NEAR_CHAIN,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";

const transfersIn = (outcome: Parameters<typeof nearUsdcTransfersIn>[0]) =>
  nearUsdcTransfersIn(outcome, TEST_USDC_CONTRACT);

const eventLog = (event: unknown): string =>
  `EVENT_JSON:${JSON.stringify(event)}`;

describe("nearUsdcTransfersIn", () => {
  it("reads sender, recipient, amount and position from a USDC transfer event", () => {
    // #given
    const from = randomNearAccount();
    const to = "payee.near";
    const outcome = nearOutcome([
      { executorId: from },
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [ftTransferLog([{ from, to, amount: 20_000_000n }])],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([
      {
        from,
        to,
        amount: 20_000_000n,
        logIndex: 0,
        blockHeight: 436n,
        txHash: outcome.txHash,
      },
    ]);
  });

  it("keeps the transaction hash's case", () => {
    // #given
    const txHash = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const outcome = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [ftTransferLog([{ from: "a.near", to: "b.near", amount: 1n }])],
        },
      ],
      { txHash },
    );

    // #when
    const [transfer] = transfersIn(outcome);

    // #then
    expect(transfer?.txHash).toBe(txHash);
  });

  it.each([
    ["an unrelated contract", "evil.near"],
    ["a subaccount of the USDC contract", `x.${TEST_USDC_CONTRACT}`],
    [
      "an account ending in the USDC contract's name",
      `evil-${TEST_USDC_CONTRACT}`,
    ],
    [
      "the USDC contract's name in another case",
      TEST_USDC_CONTRACT.toUpperCase(),
    ],
  ])("ignores the same event logged by %s", (_name, executorId) => {
    // #given a contract anyone can deploy logs a perfect USDC transfer
    const outcome = nearOutcome([
      {
        executorId,
        logs: [
          ftTransferLog([
            {
              from: "attacker.near",
              to: randomNearAccount(),
              amount: 10n ** 12n,
            },
          ]),
        ],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it("ignores a USDC event from a receipt that failed", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: TEST_USDC_CONTRACT,
        succeeded: false,
        logs: [ftTransferLog([{ from: "a.near", to: "b.near", amount: 5n }])],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it("still reads a transfer whose receipt succeeded in a transaction that failed later", () => {
    // #given
    const outcome = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [ftTransferLog([{ from: "a.near", to: "b.near", amount: 5n }])],
        },
        { executorId: "receiver.near", succeeded: false },
      ],
      { succeeded: false },
    );

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toHaveLength(1);
  });

  it.each([
    [
      "a mint",
      {
        standard: "nep141",
        event: "ft_mint",
        data: [{ owner_id: "b.near", amount: "5" }],
      },
    ],
    [
      "an NFT transfer",
      {
        standard: "nep171",
        event: "nft_transfer",
        data: [{ old_owner_id: "a.near", new_owner_id: "b.near", amount: "5" }],
      },
    ],
    [
      "a transfer event with no data",
      { standard: "nep141", event: "ft_transfer" },
    ],
    [
      "a transfer event whose data isn't a list",
      {
        standard: "nep141",
        event: "ft_transfer",
        data: { old_owner_id: "a.near", new_owner_id: "b.near", amount: "5" },
      },
    ],
  ])("ignores %s from the USDC contract", (_name, event) => {
    // #given
    const outcome = nearOutcome([
      { executorId: TEST_USDC_CONTRACT, logs: [eventLog(event)] },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it.each([
    ["plain text", "Transfer 5 from a.near to b.near"],
    ["broken JSON", "EVENT_JSON:{not json"],
    [
      "a lowercase prefix",
      ftTransferLog([{ from: "a.near", to: "b.near", amount: 5n }]).replace(
        "EVENT_JSON",
        "event_json",
      ),
    ],
    [
      "text before the prefix",
      ` ${ftTransferLog([{ from: "a.near", to: "b.near", amount: 5n }])}`,
    ],
    ["a JSON null", "EVENT_JSON:null"],
  ])("ignores a USDC log that is %s", (_name, log) => {
    // #given
    const outcome = nearOutcome([
      { executorId: TEST_USDC_CONTRACT, logs: [log] },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it.each([
    ["a negative amount", { from: "a.near", to: "b.near", amount: "-5" }],
    ["a decimal amount", { from: "a.near", to: "b.near", amount: "5.5" }],
    ["a hex amount", { from: "a.near", to: "b.near", amount: "0x05" }],
    ["a zero amount", { from: "a.near", to: "b.near", amount: "0" }],
    [
      "an amount past a u128",
      { from: "a.near", to: "b.near", amount: (2n ** 128n).toString() },
    ],
    [
      "a sender that isn't an account ID",
      { from: "A.near", to: "b.near", amount: "5" },
    ],
    [
      "a recipient that isn't an account ID",
      { from: "a.near", to: "", amount: "5" },
    ],
  ])("ignores an entry with %s", (_name, entry) => {
    // #given
    const outcome = nearOutcome([
      { executorId: TEST_USDC_CONTRACT, logs: [ftTransferLog([entry])] },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it("ignores an entry whose amount is a number rather than a string", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          eventLog({
            standard: "nep141",
            event: "ft_transfer",
            data: [
              { old_owner_id: "a.near", new_owner_id: "b.near", amount: 5 },
            ],
          }),
        ],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome);

    // #then
    expect(transfers).toEqual([]);
  });

  it("gives every transfer in one event its own position", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          ftTransferLog([
            { from: "a.near", to: "b.near", amount: 1n },
            { from: "a.near", to: "c.near", amount: 2n },
          ]),
        ],
      },
    ]);

    // #when
    const positions = transfersIn(outcome).map((transfer) => transfer.logIndex);

    // #then
    expect(positions).toEqual([0, 1]);
  });

  it("positions a transfer by where its log sits among all the transaction's logs", () => {
    // #given logs before it from another contract and from a failed receipt
    const transfer = ftTransferLog([
      { from: "a.near", to: "b.near", amount: 1n },
    ]);
    const outcome = nearOutcome([
      { executorId: "other.near", logs: ["hello", transfer] },
      { executorId: TEST_USDC_CONTRACT, succeeded: false, logs: [transfer] },
      { executorId: TEST_USDC_CONTRACT, logs: ["Refund 1", transfer] },
    ]);

    // #when
    const positions = transfersIn(outcome).map((found) => found.logIndex);

    // #then
    expect(positions).toEqual([4 * LOG_INDEX_STRIDE]);
  });

  it("keeps a valid entry's position when the one before it is invalid", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          ftTransferLog([
            { from: "a.near", to: "b.near", amount: "-1" },
            { from: "a.near", to: "c.near", amount: 2n },
          ]),
        ],
      },
    ]);

    // #when
    const positions = transfersIn(outcome).map((transfer) => transfer.logIndex);

    // #then
    expect(positions).toEqual([1]);
  });

  it("reads both legs of a transfer that was returned", () => {
    // #given an ft_transfer_call whose receiver gave the USDC back
    const outcome = nearOutcome([
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [ftTransferLog([{ from: "a.near", to: "b.near", amount: 9n }])],
      },
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [ftTransferLog([{ from: "b.near", to: "a.near", amount: 9n }])],
      },
    ]);

    // #when
    const transfers = transfersIn(outcome).map(({ from, to }) => ({
      from,
      to,
    }));

    // #then
    expect(transfers).toEqual([
      { from: "a.near", to: "b.near" },
      { from: "b.near", to: "a.near" },
    ]);
  });
});

describe("nearIntentsTransfersIn", () => {
  const BASE_USDC =
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
  const SOL_USDC =
    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
  const from = randomNearAccount();
  const to = "deposit-address.near";
  const intentsIn = (outcome: Parameters<typeof nearIntentsTransfersIn>[0]) =>
    nearIntentsTransfersIn(outcome, TEST_INTENTS_CONTRACT);

  it("reads each token of an mt_transfer entry with its receipt and position", () => {
    // #given
    const outcome = nearOutcome([
      { executorId: from },
      {
        executorId: TEST_INTENTS_CONTRACT,
        logs: [
          mtTransferLog([
            { from, to, tokenIds: [BASE_USDC, SOL_USDC], amounts: [7n, 9n] },
          ]),
        ],
      },
    ]);

    // #when
    const transfers = intentsIn(outcome);

    // #then
    const receiptId = outcome.receipts[1]?.receiptId;
    expect(transfers).toEqual([
      { from, to, tokenId: BASE_USDC, amount: 7n, receiptId, logIndex: 0 },
      { from, to, tokenId: SOL_USDC, amount: 9n, receiptId, logIndex: 1 },
    ]);
  });

  it("numbers entries by the log's position in the whole transaction", () => {
    // #given
    const outcome = nearOutcome([
      { executorId: from, logs: ["unrelated"] },
      {
        executorId: TEST_INTENTS_CONTRACT,
        logs: [
          mtTransferLog([{ from, to, tokenIds: [BASE_USDC], amounts: [1n] }]),
          mtTransferLog([
            { from, to, tokenIds: [BASE_USDC], amounts: [2n] },
            { from, to, tokenIds: [SOL_USDC], amounts: [3n] },
          ]),
        ],
      },
    ]);

    // #when
    const indexes = intentsIn(outcome).map((transfer) => transfer.logIndex);

    // #then
    expect(indexes).toEqual([
      1 * LOG_INDEX_STRIDE,
      2 * LOG_INDEX_STRIDE,
      2 * LOG_INDEX_STRIDE + 1,
    ]);
  });

  it("ignores a memo and anything that isn't an mt_transfer", () => {
    // #given
    const mint = `EVENT_JSON:${JSON.stringify({
      standard: "nep245",
      version: "1.0.0",
      event: "mt_mint",
      data: [{ owner_id: from, token_ids: [BASE_USDC], amounts: ["5"] }],
    })}`;
    const withMemo = `EVENT_JSON:${JSON.stringify({
      standard: "nep245",
      version: "1.0.0",
      event: "mt_transfer",
      data: [
        {
          old_owner_id: from,
          new_owner_id: to,
          token_ids: [BASE_USDC],
          amounts: ["4"],
          memo: "refund",
        },
      ],
    })}`;
    const outcome = nearOutcome([
      { executorId: TEST_INTENTS_CONTRACT, logs: [mint, "not json", withMemo] },
    ]);

    // #when
    const transfers = intentsIn(outcome);

    // #then
    expect(
      transfers.map(({ tokenId, amount }) => ({ tokenId, amount })),
    ).toEqual([{ tokenId: BASE_USDC, amount: 4n }]);
  });

  it.each([
    ["another contract logged it", { executorId: "evil.near" }],
    [
      "the receipt failed",
      { executorId: TEST_INTENTS_CONTRACT, succeeded: false },
    ],
  ])("ignores a transfer when %s", (_name, receipt) => {
    // #given
    const outcome = nearOutcome([
      {
        ...receipt,
        logs: [
          mtTransferLog([{ from, to, tokenIds: [BASE_USDC], amounts: [1n] }]),
        ],
      },
    ]);

    // #then
    expect(intentsIn(outcome)).toEqual([]);
  });

  it("ignores a USDC ft_transfer event from the Intents contract and the reverse", () => {
    // #given
    const outcome = nearOutcome([
      {
        executorId: TEST_INTENTS_CONTRACT,
        logs: [ftTransferLog([{ from, to, amount: 1n }])],
      },
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          mtTransferLog([{ from, to, tokenIds: [BASE_USDC], amounts: [1n] }]),
        ],
      },
    ]);

    // #then
    expect(intentsIn(outcome)).toEqual([]);
  });

  it.each([
    [
      "token IDs and amounts of different lengths",
      { from, to, tokenIds: [BASE_USDC, SOL_USDC], amounts: [1n] },
    ],
    ["a zero amount", { from, to, tokenIds: [BASE_USDC], amounts: [0n] }],
    [
      "an amount past u128",
      { from, to, tokenIds: [BASE_USDC], amounts: [2n ** 128n] },
    ],
    [
      "an invalid account",
      { from: "Not An Account", to, tokenIds: [BASE_USDC], amounts: [1n] },
    ],
    [
      "a non-numeric amount",
      { from, to, tokenIds: [BASE_USDC], amounts: ["1.5"] },
    ],
  ])("skips an entry with %s", (_name, entry) => {
    // #given
    const outcome = nearOutcome([
      { executorId: TEST_INTENTS_CONTRACT, logs: [mtTransferLog([entry])] },
    ]);

    // #then
    expect(intentsIn(outcome)).toEqual([]);
  });
});

describe("intentsTokenTransferAction", () => {
  const TOKEN =
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

  it("calls mt_transfer with one yoctoNEAR and the amount as a string", () => {
    // #when
    const action = intentsTokenTransferAction("deposit.near", TOKEN, 123n);

    // #then
    expect(action.functionCall?.methodName).toBe("mt_transfer");
    expect(action.functionCall?.deposit).toBe(1n);
    expect(
      JSON.parse(Buffer.from(action.functionCall?.args ?? []).toString("utf8")),
    ).toEqual({ receiver_id: "deposit.near", token_id: TOKEN, amount: "123" });
  });

  it.each([
    ["an invalid receiver", "Bad Receiver", TOKEN, 1n],
    ["a zero amount", "deposit.near", TOKEN, 0n],
    ["an amount past u128", "deposit.near", TOKEN, 2n ** 128n],
    ["an empty token ID", "deposit.near", "", 1n],
  ])("refuses %s", (_name, receiver, tokenId, amount) => {
    expect(() => intentsTokenTransferAction(receiver, tokenId, amount)).toThrow(
      RangeError,
    );
  });

  it("is sent to the NEAR Intents contract of the network", () => {
    expect(TEST_NEAR_CHAIN.intentsContractId).toBe("intents.testnet");
  });
});
