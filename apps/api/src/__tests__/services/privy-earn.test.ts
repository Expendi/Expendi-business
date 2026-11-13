import type { PrivyClient } from "@privy-io/node";
import { APIError } from "@privy-io/node";
import { Effect, Either, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { makePrivyWallets } from "../../services/wallet/privy-wallets.js";

const WALLET_ID = "wallet-1";
const RUNTIME_KEY = "runtime-key";
const HASH = `0x${"ab".repeat(32)}`;

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Just the calls Earn makes, recording what the API sent them. */
function fakeClient(answers: {
  readonly deposit?: () => unknown;
  readonly action?: () => unknown;
}) {
  const calls: Call[] = [];
  const record =
    (method: string, answer: () => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(answer());
    };
  const earn = {
    deposit: record("deposit", answers.deposit ?? (() => depositAction())),
    withdraw: record("withdraw", () => depositAction()),
    vaultPosition: record("vaultPosition", () => ({
      assets_in_vault: "999999",
      shares_in_vault: "999994",
      total_deposited: "0",
      total_withdrawn: "0",
    })),
    vaultDetails: record("vaultDetails", () => ({
      name: "Aave USDC",
      user_apy: 519,
      available_liquidity_usd: 15_500_000,
    })),
  };
  const client = {
    wallets: () => ({
      earn: () => ({ ethereum: () => earn }),
      actions: {
        get: record("get", answers.action ?? (() => depositAction())),
      },
    }),
  };
  return { client: client as unknown as PrivyClient, calls };
}

const depositAction = (overrides: Record<string, unknown> = {}) => ({
  id: "action-1",
  type: "earn_deposit",
  status: "pending",
  raw_amount: "1000000",
  share_amount: null,
  steps: [],
  ...overrides,
});

const service = (client: PrivyClient) =>
  makePrivyWallets(client, Redacted.make(RUNTIME_KEY));

const input = {
  privyWalletId: WALLET_ID,
  vaultId: "vault-1",
  rawAmount: 1_000_000n,
  referenceId: "tr-0b1d5c2e-1111-4222-8333-944455556666-1",
};

const apiError = (status: number, message: string) =>
  APIError.generate(status, { error: message }, message, new Headers());

describe("Privy Earn calls", () => {
  it("deposits with raw_amount, one key as both reference and idempotency key, and the runtime key", async () => {
    // #given
    const { client, calls } = fakeClient({});

    // #when
    const action = await Effect.runPromise(service(client).earnDeposit(input));

    // #then
    expect(calls).toEqual([
      {
        method: "deposit",
        args: [
          WALLET_ID,
          {
            vault_id: "vault-1",
            raw_amount: "1000000",
            reference_id: input.referenceId,
            idempotency_key: input.referenceId,
            authorization_context: {
              authorization_private_keys: [RUNTIME_KEY],
            },
          },
        ],
      },
    ]);
    expect(action).toEqual({
      actionId: "action-1",
      status: "pending",
      rawAmount: 1_000_000n,
      shareAmount: null,
      txHash: null,
      failureReason: null,
    });
  });

  it("withdraws the same way", async () => {
    // #given
    const { client, calls } = fakeClient({});

    // #when
    await Effect.runPromise(service(client).earnWithdraw(input));

    // #then
    expect(calls.map((call) => call.method)).toEqual(["withdraw"]);
  });

  it.each([
    [404, "Vault not found"],
    [400, "invalid_data: Insufficient balance"],
    [422, "policy_violation"],
  ])("reads a %s as nothing signed", async (status, message) => {
    // #given
    const { client } = fakeClient({
      deposit: () => {
        throw apiError(status, message);
      },
    });

    // #when
    const result = await Effect.runPromise(
      Effect.either(service(client).earnDeposit(input)),
    );

    // #then
    expect(Either.isLeft(result) && result.left._tag).toBe("SendRefused");
  });

  it.each([[500], [503], [408], [409], [429]])(
    "reads a %s as an outcome nobody knows",
    async (status) => {
      // #given
      const { client } = fakeClient({
        deposit: () => {
          throw apiError(status, "try later");
        },
      });

      // #when
      const result = await Effect.runPromise(
        Effect.either(service(client).earnDeposit(input)),
      );

      // #then
      expect(Either.isLeft(result) && result.left._tag).toBe(
        "SendOutcomeUnknown",
      );
    },
  );

  it("reads a lost reply as an outcome nobody knows", async () => {
    // #given
    const { client } = fakeClient({
      deposit: () => {
        throw new Error("socket hang up");
      },
    });

    // #when
    const result = await Effect.runPromise(
      Effect.either(service(client).earnDeposit(input)),
    );

    // #then
    expect(Either.isLeft(result) && result.left._tag).toBe(
      "SendOutcomeUnknown",
    );
  });

  it("reads an action with steps and takes the user operation's bundle hash", async () => {
    // #given
    const { client, calls } = fakeClient({
      action: () =>
        depositAction({
          status: "succeeded",
          share_amount: "999994",
          steps: [
            {
              type: "evm_user_operation",
              status: "confirmed",
              bundle_transaction_hash: HASH.toUpperCase().replace("0X", "0x"),
              user_operation_hash: `0x${"cd".repeat(32)}`,
            },
          ],
        }),
    });

    // #when
    const action = await Effect.runPromise(
      service(client).getWalletAction({
        privyWalletId: WALLET_ID,
        actionId: "action-1",
      }),
    );

    // #then
    expect(calls).toEqual([
      {
        method: "get",
        args: ["action-1", { wallet_id: WALLET_ID, include: "steps" }],
      },
    ]);
    expect(action).toMatchObject({
      status: "succeeded",
      shareAmount: 999_994n,
      txHash: HASH,
    });
  });

  it("carries the reason an action was rejected", async () => {
    // #given
    const { client } = fakeClient({
      action: () =>
        depositAction({
          status: "rejected",
          failure_reason: { message: "policy_violation" },
        }),
    });

    // #when
    const action = await Effect.runPromise(
      service(client).getWalletAction({
        privyWalletId: WALLET_ID,
        actionId: "action-1",
      }),
    );

    // #then
    expect(action).toMatchObject({
      status: "rejected",
      failureReason: "policy_violation",
      txHash: null,
    });
  });

  it("reads the position and the vault", async () => {
    // #given
    const { client } = fakeClient({});
    const privy = service(client);

    // #when
    const position = await Effect.runPromise(
      privy.vaultPosition({ privyWalletId: WALLET_ID, vaultId: "vault-1" }),
    );
    const vault = await Effect.runPromise(privy.vaultDetails("vault-1"));

    // #then
    expect({ position, vault }).toEqual({
      position: {
        assetsInVault: 999_999n,
        sharesInVault: 999_994n,
        totalDeposited: 0n,
        totalWithdrawn: 0n,
      },
      vault: {
        name: "Aave USDC",
        userApyBps: 519,
        availableLiquidityUsd: 15_500_000,
      },
    });
  });
});
