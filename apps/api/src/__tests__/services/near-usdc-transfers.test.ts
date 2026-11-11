import { describe, expect, it } from "vitest";

import {
  LOG_INDEX_STRIDE,
  nearUsdcTransfersIn,
} from "../../services/chain/near.js";
import {
  ftTransferLog,
  nearOutcome,
  randomNearAccount,
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
