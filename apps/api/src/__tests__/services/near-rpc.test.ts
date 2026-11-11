import { Effect, Exit, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makeNearRpc } from "../../services/chain/near-rpc.js";
import {
  ftTransferLog,
  randomNearAccount,
  randomNearTxHash,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";

interface RpcRequest {
  readonly method: string;
  readonly params: Record<string, unknown> | readonly unknown[];
}

type RpcAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly cause: { readonly name: string } } }
  | { readonly httpStatus: number };

const handlerError = (name: string): RpcAnswer => ({
  error: { cause: { name } },
});

/** A NEAR RPC node that answers each request with whatever `answer` returns. */
function nodeAnswering(answer: (request: RpcRequest) => RpcAnswer) {
  const requests: RpcRequest[] = [];
  const fetchImpl: typeof fetch = (_url, init) => {
    const request = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as RpcRequest;
    requests.push(request);
    const answered = answer(request);
    return Promise.resolve(
      "httpStatus" in answered
        ? new Response("unavailable", { status: answered.httpStatus })
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...answered })),
    );
  };
  const rpc = makeNearRpc(
    Redacted.make("https://rpc.near.test/key"),
    TEST_USDC_CONTRACT,
    fetchImpl,
  );
  return { rpc, requests };
}

const viewResult = (value: unknown): RpcAnswer => ({
  result: { result: [...Buffer.from(JSON.stringify(value))], logs: [] },
});

const company = randomNearAccount();
const relayer = "relayer.near";
const TX_HASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BLOCK_HASH = randomNearTxHash();

function finalTransaction(overrides: Record<string, unknown> = {}) {
  const ownReceiptId = randomNearTxHash();
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: { hash: TX_HASH, signer_id: relayer, receiver_id: company },
    transaction_outcome: {
      block_hash: BLOCK_HASH,
      outcome: { receipt_ids: [ownReceiptId] },
    },
    receipts_outcome: [
      {
        id: ownReceiptId,
        outcome: {
          executor_id: company,
          logs: [],
          status: { SuccessReceiptId: randomNearTxHash() },
        },
      },
      {
        id: randomNearTxHash(),
        outcome: {
          executor_id: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([{ from: company, to: "payee.near", amount: 5n }]),
          ],
          status: { SuccessValue: "" },
        },
      },
      {
        id: randomNearTxHash(),
        outcome: {
          executor_id: "refunds.near",
          logs: [],
          status: { Failure: { ActionError: { index: 0 } } },
        },
      },
    ],
    ...overrides,
  };
}

const answeringTransaction = (transaction: unknown) =>
  nodeAnswering(({ method }) =>
    method === "tx"
      ? { result: transaction }
      : { result: { header: { height: 150_000_123, hash: BLOCK_HASH } } },
  );

describe("NearRpc.transactionOutcome", () => {
  it("reads a final transaction, with each receipt's executor, logs and success", async () => {
    // #given
    const transaction = finalTransaction();
    const { rpc } = answeringTransaction(transaction);

    // #when
    const outcome = await Effect.runPromise(
      rpc.transactionOutcome(TX_HASH, relayer),
    );

    // #then
    expect(outcome).toMatchObject({
      txHash: TX_HASH,
      signerId: relayer,
      receiverId: company,
      blockHeight: 150_000_123n,
      succeeded: true,
      successValue: "",
      ownReceiptId: transaction.receipts_outcome[0]?.id,
      receipts: [
        { executorId: company, succeeded: true, logs: [] },
        { executorId: TEST_USDC_CONTRACT, succeeded: true },
        { executorId: "refunds.near", succeeded: false },
      ],
    });
  });

  it("asks by hash and signer without waiting, keeping the hash's case", async () => {
    // #given
    const { rpc, requests } = answeringTransaction(finalTransaction());

    // #when
    await Effect.runPromise(rpc.transactionOutcome(TX_HASH, relayer));

    // #then
    expect(requests[0]).toMatchObject({
      method: "tx",
      params: {
        tx_hash: TX_HASH,
        sender_account_id: relayer,
        wait_until: "NONE",
      },
    });
  });

  it("reports a failed transaction as final and not succeeded", async () => {
    // #given
    const { rpc } = answeringTransaction(
      finalTransaction({ status: { Failure: { ActionError: {} } } }),
    );

    // #when
    const outcome = await Effect.runPromise(
      rpc.transactionOutcome(TX_HASH, relayer),
    );

    // #then
    expect(outcome).toMatchObject({ succeeded: false, successValue: null });
  });

  it("is null while the chain doesn't know the transaction", async () => {
    // #given
    const { rpc } = nodeAnswering(() => handlerError("UNKNOWN_TRANSACTION"));

    // #when
    const outcome = await Effect.runPromise(
      rpc.transactionOutcome(TX_HASH, relayer),
    );

    // #then
    expect(outcome).toBeNull();
  });

  it.each([["NONE"], ["INCLUDED"], ["EXECUTED_OPTIMISTIC"], ["EXECUTED"]])(
    "is null while the transaction is only %s",
    async (progress) => {
      // #given
      const { rpc } = answeringTransaction(
        finalTransaction({ final_execution_status: progress }),
      );

      // #when
      const outcome = await Effect.runPromise(
        rpc.transactionOutcome(TX_HASH, relayer),
      );

      // #then
      expect(outcome).toBeNull();
    },
  );

  it.each([
    ["the node is down", () => ({ httpStatus: 503 })],
    [
      "the node reports an internal error",
      () => handlerError("INTERNAL_ERROR"),
    ],
    [
      "a final transaction has no receipts listed",
      () => ({ result: finalTransaction({ receipts_outcome: undefined }) }),
    ],
  ] satisfies [string, () => RpcAnswer][])(
    "fails, rather than answering null, when %s",
    async (_name, answer) => {
      // #given
      const { rpc } = nodeAnswering(answer);

      // #when
      const exit = await Effect.runPromiseExit(
        rpc.transactionOutcome(TX_HASH, relayer),
      );

      // #then
      expect(Exit.isFailure(exit)).toBe(true);
    },
  );
});

describe("NearRpc account reads", () => {
  it("says an account doesn't exist when the chain has no such account", async () => {
    // #given
    const { rpc } = nodeAnswering(() => handlerError("UNKNOWN_ACCOUNT"));

    // #when
    const exists = await Effect.runPromise(rpc.accountExists(company));

    // #then
    expect(exists).toBe(false);
  });

  it("says an account exists when the chain returns it", async () => {
    // #given
    const { rpc } = nodeAnswering(() => ({
      result: { amount: "0", code_hash: "11111111111111111111111111111111" },
    }));

    // #when
    const exists = await Effect.runPromise(rpc.accountExists(company));

    // #then
    expect(exists).toBe(true);
  });

  it.each([
    ["isn't registered when USDC has no storage balance for it", null, false],
    [
      "is registered when USDC holds a storage balance for it",
      { total: "1250000000000000000000", available: "0" },
      true,
    ],
  ])("says an account %s", async (_name, storageBalance, expected) => {
    // #given
    const { rpc, requests } = nodeAnswering(() => viewResult(storageBalance));

    // #when
    const registered = await Effect.runPromise(
      rpc.usdcStorageRegistered(company),
    );

    // #then
    expect(registered).toBe(expected);
    expect(requests[0]?.params).toMatchObject({
      request_type: "call_function",
      account_id: TEST_USDC_CONTRACT,
      method_name: "storage_balance_of",
      finality: "final",
    });
  });

  it("reads a USDC balance as base units", async () => {
    // #given
    const { rpc } = nodeAnswering(() => viewResult("12500000"));

    // #when
    const balance = await Effect.runPromise(rpc.usdcBalance(company));

    // #then
    expect(balance).toBe(12_500_000n);
  });

  it("fails on a USDC balance that isn't a whole number", async () => {
    // #given
    const { rpc } = nodeAnswering(() => viewResult("12.5"));

    // #when
    const exit = await Effect.runPromiseExit(rpc.usdcBalance(company));

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("reads the latest final block", async () => {
    // #given
    const { rpc, requests } = nodeAnswering(() => ({
      result: { header: { height: 150_000_123, hash: BLOCK_HASH } },
    }));

    // #when
    const block = await Effect.runPromise(rpc.finalBlock());

    // #then
    expect(block).toEqual({ height: 150_000_123n, hash: BLOCK_HASH });
    expect(requests[0]).toMatchObject({
      method: "block",
      params: { finality: "final" },
    });
  });
});

describe("NearRpc.accessKeyNonce", () => {
  const publicKey = "ed25519:8kVqZBDUE5gVJmxvFEpBHnEXhFE3uTnYxCzwuzHbMn7u";

  it("reads the nonce at the final block by default", async () => {
    // #given
    const { rpc, requests } = nodeAnswering(() => ({
      result: { nonce: 150_000_000_000_007, permission: "FullAccess" },
    }));

    // #when
    const nonce = await Effect.runPromise(
      rpc.accessKeyNonce({ accountId: company, publicKey }),
    );

    // #then
    expect(nonce).toBe(150_000_000_000_007n);
    expect(requests[0]?.params).toMatchObject({
      request_type: "view_access_key",
      account_id: company,
      public_key: publicKey,
      finality: "final",
    });
  });

  it("reads the nonce at exactly the block asked for", async () => {
    // #given
    const { rpc, requests } = nodeAnswering(() => ({ result: { nonce: 7 } }));

    // #when
    await Effect.runPromise(
      rpc.accessKeyNonce({
        accountId: company,
        publicKey,
        atBlockHeight: 150_000_321n,
      }),
    );

    // #then
    expect(requests[0]?.params).toMatchObject({ block_id: 150_000_321 });
    expect(requests[0]?.params).not.toHaveProperty("finality");
  });

  it.each([["UNKNOWN_ACCOUNT"], ["UNKNOWN_ACCESS_KEY"]])(
    "is null when the chain answers %s",
    async (cause) => {
      // #given
      const { rpc } = nodeAnswering(() => handlerError(cause));

      // #when
      const nonce = await Effect.runPromise(
        rpc.accessKeyNonce({ accountId: company, publicKey }),
      );

      // #then
      expect(nonce).toBeNull();
    },
  );

  it("fails when the node hasn't the block asked for, rather than answering from an older one", async () => {
    // #given
    const { rpc } = nodeAnswering(() => handlerError("UNKNOWN_BLOCK"));

    // #when
    const exit = await Effect.runPromiseExit(
      rpc.accessKeyNonce({
        accountId: company,
        publicKey,
        atBlockHeight: 150_000_321n,
      }),
    );

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("NearRpc.broadcast", () => {
  it("hands the signed bytes to the node as base64, without waiting", async () => {
    // #given
    const { rpc, requests } = nodeAnswering(() => ({ result: TX_HASH }));

    // #when
    await Effect.runPromise(rpc.broadcast(Uint8Array.from([1, 2, 3, 250])));

    // #then
    expect(requests).toEqual([
      expect.objectContaining({
        method: "broadcast_tx_async",
        params: ["AQID+g=="],
      }),
    ]);
  });

  it("fails when the node rejects the transaction", async () => {
    // #given
    const { rpc } = nodeAnswering(() => handlerError("INVALID_TRANSACTION"));

    // #when
    const exit = await Effect.runPromiseExit(
      rpc.broadcast(Uint8Array.from([1])),
    );

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
