import { createHash, randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import {
  baseEncode,
  decodeSignedTransaction,
  encodeDelegateAction,
  encodeTransaction,
  PublicKey,
} from "near-api-js";

import type { NearRelayerShape } from "../../services/chain/near-relayer.js";
import type { NearRpcShape } from "../../services/chain/near-rpc.js";
import type {
  NearReceiptOutcome,
  NearTransactionOutcome,
} from "../../services/chain/near.js";
import type { makeFakePrivyWallets } from "./fakes.js";
import {
  makeNearRelayer,
  NearRelayer,
  NearRelayerError,
} from "../../services/chain/near-relayer.js";
import { NearRpc, NearRpcError } from "../../services/chain/near-rpc.js";
import {
  makeNearChain,
  NEAR_ED25519,
  NearChain,
} from "../../services/chain/near.js";

export const TEST_NEAR_CHAIN = makeNearChain("testnet");
export const TEST_USDC_CONTRACT = TEST_NEAR_CHAIN.usdcContractId;
export const TEST_INTENTS_CONTRACT = TEST_NEAR_CHAIN.intentsContractId;
export const TestNearChain = Layer.succeed(NearChain, TEST_NEAR_CHAIN);

/** An implicit account ID nobody holds the key to. */
export const randomNearAccount = (): string => randomBytes(32).toString("hex");

export const randomNearTxHash = (): string => baseEncode(randomBytes(32));

export interface FtTransferEntry {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint | string;
}

/** A NEP-297 `ft_transfer` event log, as a NEP-141 contract emits it. */
export const ftTransferLog = (entries: readonly FtTransferEntry[]): string =>
  `EVENT_JSON:${JSON.stringify({
    standard: "nep141",
    version: "1.0.0",
    event: "ft_transfer",
    data: entries.map((entry) => ({
      old_owner_id: entry.from,
      new_owner_id: entry.to,
      amount: entry.amount.toString(),
    })),
  })}`;

export interface MtTransferEntry {
  readonly from: string;
  readonly to: string;
  readonly tokenIds: readonly string[];
  readonly amounts: readonly (bigint | string)[];
}

/** A NEP-245 `mt_transfer` event log, as the NEAR Intents contract emits it. */
export const mtTransferLog = (entries: readonly MtTransferEntry[]): string =>
  `EVENT_JSON:${JSON.stringify({
    standard: "nep245",
    version: "1.0.0",
    event: "mt_transfer",
    data: entries.map((entry) => ({
      old_owner_id: entry.from,
      new_owner_id: entry.to,
      token_ids: entry.tokenIds,
      amounts: entry.amounts.map((amount) => amount.toString()),
    })),
  })}`;

/** A final transaction outcome with one receipt per entry, in order. */
export function nearOutcome(
  receipts: readonly {
    readonly executorId: string;
    readonly logs?: readonly string[];
    readonly succeeded?: boolean;
  }[],
  options: Partial<
    Pick<
      NearTransactionOutcome,
      "txHash" | "signerId" | "receiverId" | "succeeded" | "successValue"
    >
  > = {},
): NearTransactionOutcome {
  const outcomes: NearReceiptOutcome[] = receipts.map((receipt) => ({
    receiptId: randomNearTxHash(),
    executorId: receipt.executorId,
    logs: receipt.logs ?? [],
    succeeded: receipt.succeeded ?? true,
  }));
  const succeeded = options.succeeded ?? true;
  return {
    txHash: options.txHash ?? randomNearTxHash(),
    signerId: options.signerId ?? randomNearAccount(),
    receiverId: options.receiverId ?? receipts[0]?.executorId ?? "nobody.near",
    blockHeight: 436n,
    succeeded,
    successValue: succeeded ? (options.successValue ?? "") : null,
    ownReceiptId: outcomes[0]?.receiptId ?? randomNearTxHash(),
    receipts: outcomes,
  };
}

type RpcCall = keyof NearRpcShape;

/**
 * What the chain does with the next broadcast transaction:
 * - `run`: it runs and its outcome is final at once;
 * - `withhold`: it runs, but its outcome stays unknown until `release()`;
 * - `drop`: the node accepts it and it never reaches a block;
 * - `reject`: the node answers with an error and it never reaches a block;
 * - `lose_reply`: it runs, but the node's reply to the broadcast is lost.
 */
type BroadcastMode = "run" | "withhold" | "drop" | "reject" | "lose_reply";

interface FunctionCallView {
  readonly methodName: string;
  readonly args: Uint8Array | readonly number[];
  readonly deposit: bigint;
}

const sha256 = (bytes: Uint8Array): Uint8Array =>
  Uint8Array.from(createHash("sha256").update(bytes).digest());

const toBytes = (bytes: Uint8Array | readonly number[]): Uint8Array =>
  Uint8Array.from(bytes);

const base64Json = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64");

function callArgs(call: FunctionCallView): Record<string, unknown> {
  return JSON.parse(Buffer.from(toBytes(call.args)).toString("utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * A small NEAR in memory, strict where the real chain is: signatures must
 * verify, an account must exist before it can act, a nonce runs once and
 * must be higher than the last, a delegate action is refused after its
 * expiry, and USDC moves only between registered accounts that can cover
 * it. Transactions are the real borsh bytes the API would broadcast.
 */
export function makeFakeNearRpc(
  usdcContractId = TEST_USDC_CONTRACT,
  intentsContractId = TEST_INTENTS_CONTRACT,
) {
  /** Accounts that exist on chain, with their access key's nonce. */
  const accounts = new Map<string, bigint>();
  const registered = new Set<string>();
  const balances = new Map<string, bigint>();
  /** What each account holds inside NEAR Intents, keyed by account then token. */
  const intentsHoldings = new Map<string, Map<string, bigint>>();
  const outcomes = new Map<string, NearTransactionOutcome>();
  const withheld = new Map<string, NearTransactionOutcome>();
  /** The hash of every transaction handed to the node, in order. */
  const broadcasts: string[] = [];
  /** The hash of every transaction outcome looked up, in order. */
  const outcomeLookups: string[] = [];
  const broadcastModes: BroadcastMode[] = [];
  const failures = new Map<RpcCall, number>();

  const state = {
    accounts,
    registered,
    balances,
    outcomes,
    broadcasts,
    outcomeLookups,
    height: 150_000_000n,
    /** Whether the receiver of the next `ft_transfer_call`s keeps the USDC. */
    transferCallReceiverKeeps: true,
    /** Queue what happens to the next broadcasts; each without one runs. */
    nextBroadcasts(...modes: BroadcastMode[]) {
      broadcastModes.push(...modes);
    },
    /** Makes every withheld outcome final and visible. */
    release() {
      for (const [txHash, outcome] of withheld) outcomes.set(txHash, outcome);
      withheld.clear();
    },
    /** The next `times` calls of `call` fail. */
    failNext(call: RpcCall, times = 1) {
      failures.set(call, times);
    },
    /** Puts an account on chain, as receiving NEAR does. */
    createAccount(accountId: string) {
      if (!accounts.has(accountId)) accounts.set(accountId, 0n);
    },
    /** An account on chain, registered with USDC and holding `amount`. */
    fundWithUsdc(accountId: string, amount: bigint) {
      state.createAccount(accountId);
      registered.add(accountId);
      balances.set(accountId, (balances.get(accountId) ?? 0n) + amount);
    },
    usdcBalanceOf: (accountId: string): bigint => balances.get(accountId) ?? 0n,
    /** Credits an account with a token inside NEAR Intents. */
    fundIntents(accountId: string, tokenId: string, amount: bigint) {
      state.createAccount(accountId);
      const held = intentsHoldings.get(accountId) ?? new Map<string, bigint>();
      held.set(tokenId, (held.get(tokenId) ?? 0n) + amount);
      intentsHoldings.set(accountId, held);
    },
    intentsBalanceOf: (accountId: string, tokenId: string): bigint =>
      intentsHoldings.get(accountId)?.get(tokenId) ?? 0n,
    nonceOf: (accountId: string): bigint | null =>
      accounts.get(accountId) ?? null,
  };

  const maybeFail = (call: RpcCall): Effect.Effect<void, NearRpcError> => {
    const remaining = failures.get(call) ?? 0;
    if (remaining === 0) return Effect.void;
    failures.set(call, remaining - 1);
    return Effect.fail(new NearRpcError({ message: `fake ${call} failure` }));
  };

  /** Runs USDC's `ft_transfer` or `ft_transfer_call`; the logs if it succeeded. */
  function runUsdcCall(
    senderId: string,
    call: FunctionCallView,
  ): { readonly logs: string[]; readonly successValue: string } | null {
    const args = callArgs(call);
    const receiverId = String(args.receiver_id);
    const amount = BigInt(String(args.amount));
    if (
      call.deposit !== 1n ||
      !registered.has(senderId) ||
      !registered.has(receiverId) ||
      state.usdcBalanceOf(senderId) < amount
    ) {
      return null;
    }
    const moved = ftTransferLog([{ from: senderId, to: receiverId, amount }]);
    if (call.methodName === "ft_transfer") {
      balances.set(senderId, state.usdcBalanceOf(senderId) - amount);
      balances.set(receiverId, state.usdcBalanceOf(receiverId) + amount);
      return { logs: [moved], successValue: "" };
    }
    if (call.methodName !== "ft_transfer_call") return null;
    if (state.transferCallReceiverKeeps) {
      balances.set(senderId, state.usdcBalanceOf(senderId) - amount);
      balances.set(receiverId, state.usdcBalanceOf(receiverId) + amount);
      return { logs: [moved], successValue: base64Json(amount.toString()) };
    }
    return {
      logs: [
        moved,
        ftTransferLog([{ from: receiverId, to: senderId, amount }]),
      ],
      successValue: base64Json("0"),
    };
  }

  /** Runs NEAR Intents' `mt_transfer`; the logs if it succeeded. */
  function runIntentsCall(
    senderId: string,
    call: FunctionCallView,
  ): { readonly logs: string[]; readonly successValue: string } | null {
    if (call.methodName !== "mt_transfer") return null;
    const args = callArgs(call);
    const receiverId = String(args.receiver_id);
    const tokenId = String(args.token_id);
    const amount = BigInt(String(args.amount));
    if (
      call.deposit !== 1n ||
      state.intentsBalanceOf(senderId, tokenId) < amount
    ) {
      return null;
    }
    state.fundIntents(senderId, tokenId, -amount);
    state.fundIntents(receiverId, tokenId, amount);
    return {
      logs: [
        mtTransferLog([
          {
            from: senderId,
            to: receiverId,
            tokenIds: [tokenId],
            amounts: [amount],
          },
        ]),
      ],
      successValue: "",
    };
  }

  function run(signedBytes: Uint8Array): NearTransactionOutcome | null {
    const signed = decodeSignedTransaction(signedBytes);
    const transaction = signed.transaction;
    const txHashBytes = sha256(encodeTransaction(transaction));
    const txHash = baseEncode(txHashBytes);
    const signature = signed.signature.ed25519Signature?.data;
    const signerNonce = accounts.get(transaction.signerId);
    const [action] = transaction.actions;
    const signerKey = Buffer.from(transaction.publicKey.data).toString("hex");
    if (
      signature === undefined ||
      signerKey !== transaction.signerId ||
      !transaction.publicKey.verify(txHashBytes, toBytes(signature)) ||
      signerNonce === undefined ||
      transaction.nonce <= signerNonce ||
      action === undefined ||
      transaction.actions.length !== 1
    ) {
      return null;
    }
    accounts.set(transaction.signerId, transaction.nonce);

    const ownReceiptId = randomNearTxHash();
    const receipt = (
      executorId: string,
      succeeded: boolean,
      logs: readonly string[] = [],
      receiptId = randomNearTxHash(),
    ): NearReceiptOutcome => ({ receiptId, executorId, logs, succeeded });
    const outcome = (
      receipts: readonly NearReceiptOutcome[],
      successValue: string | null,
    ): NearTransactionOutcome => ({
      txHash,
      signerId: transaction.signerId,
      receiverId: transaction.receiverId,
      blockHeight: state.height,
      succeeded: successValue !== null,
      successValue,
      ownReceiptId,
      receipts,
    });
    const own = (succeeded: boolean) =>
      receipt(transaction.receiverId, succeeded, [], ownReceiptId);

    if (action.transfer) {
      state.createAccount(transaction.receiverId);
      return outcome([own(true)], "");
    }

    // An account moving its own USDC with a plain transaction, as the gas
    // relayer does when it covers a quote's cost.
    if (
      action.functionCall &&
      transaction.receiverId === usdcContractId &&
      action.functionCall.methodName === "ft_transfer"
    ) {
      const ran = runUsdcCall(transaction.signerId, action.functionCall);
      return outcome(
        [receipt(usdcContractId, ran !== null, ran?.logs, ownReceiptId)],
        ran?.successValue ?? null,
      );
    }

    if (action.functionCall) {
      const args = callArgs(action.functionCall);
      const registers =
        transaction.receiverId === usdcContractId &&
        action.functionCall.methodName === "storage_deposit" &&
        accounts.has(String(args.account_id));
      if (registers) registered.add(String(args.account_id));
      return outcome([own(registers)], registers ? "" : null);
    }

    if (action.signedDelegate) {
      const { delegateAction, signature: delegateSignature } =
        action.signedDelegate;
      const senderNonce = accounts.get(delegateAction.senderId);
      const senderKey = new PublicKey({
        keyType: NEAR_ED25519,
        data: Uint8Array.from(Buffer.from(delegateAction.senderId, "hex")),
      });
      const signedBySender = senderKey.verify(
        sha256(encodeDelegateAction(delegateAction)),
        toBytes(delegateSignature.ed25519Signature?.data ?? []),
      );
      const [inner] = delegateAction.actions;
      if (
        delegateAction.senderId !== transaction.receiverId ||
        !signedBySender ||
        senderNonce === undefined ||
        delegateAction.nonce <= senderNonce ||
        delegateAction.maxBlockHeight < state.height ||
        inner?.functionCall === undefined
      ) {
        return outcome([own(false)], null);
      }
      accounts.set(delegateAction.senderId, delegateAction.nonce);
      const ran =
        delegateAction.receiverId === usdcContractId
          ? runUsdcCall(delegateAction.senderId, inner.functionCall)
          : delegateAction.receiverId === intentsContractId
            ? runIntentsCall(delegateAction.senderId, inner.functionCall)
            : null;
      return outcome(
        [
          own(true),
          receipt(delegateAction.receiverId, ran !== null, ran?.logs),
        ],
        ran?.successValue ?? null,
      );
    }

    return outcome([own(false)], null);
  }

  const service: NearRpcShape = {
    transactionOutcome: (txHash) =>
      maybeFail("transactionOutcome").pipe(
        Effect.map(() => {
          outcomeLookups.push(txHash);
          return outcomes.get(txHash) ?? null;
        }),
      ),
    accountExists: (accountId) =>
      maybeFail("accountExists").pipe(
        Effect.map(() => accounts.has(accountId)),
      ),
    usdcStorageRegistered: (accountId) =>
      maybeFail("usdcStorageRegistered").pipe(
        Effect.map(() => registered.has(accountId)),
      ),
    usdcBalance: (accountId) =>
      maybeFail("usdcBalance").pipe(
        Effect.map(() => state.usdcBalanceOf(accountId)),
      ),
    intentsBalances: (accountId, tokenIds) =>
      maybeFail("intentsBalances").pipe(
        Effect.map(() =>
          tokenIds.map((tokenId) => state.intentsBalanceOf(accountId, tokenId)),
        ),
      ),
    finalBlock: () =>
      maybeFail("finalBlock").pipe(
        Effect.map(() => ({
          height: state.height,
          hash: baseEncode(sha256(Buffer.from(state.height.toString()))),
        })),
      ),
    accessKeyNonce: ({ accountId, atBlockHeight }) =>
      maybeFail("accessKeyNonce").pipe(
        Effect.flatMap(() =>
          atBlockHeight !== undefined && atBlockHeight > state.height
            ? Effect.fail(
                new NearRpcError({ message: "fake node hasn't that block" }),
              )
            : Effect.succeed(accounts.get(accountId) ?? null),
        ),
      ),
    broadcast: (signedTransaction) =>
      maybeFail("broadcast").pipe(
        Effect.flatMap(() => {
          const mode = broadcastModes.shift() ?? "run";
          const bytes = Uint8Array.from(signedTransaction);
          broadcasts.push(
            baseEncode(
              sha256(
                encodeTransaction(decodeSignedTransaction(bytes).transaction),
              ),
            ),
          );
          if (mode === "reject") {
            return Effect.fail(
              new NearRpcError({ message: "fake node rejected the broadcast" }),
            );
          }
          if (mode === "drop") return Effect.void;
          state.height += 1n;
          const outcome = run(bytes);
          if (outcome !== null) {
            (mode === "withhold" ? withheld : outcomes).set(
              outcome.txHash,
              outcome,
            );
          }
          return mode === "lose_reply"
            ? Effect.fail(new NearRpcError({ message: "fake reply lost" }))
            : Effect.void;
        }),
      ),
  };

  return {
    layer: Layer.succeed(NearRpc, service),
    service,
    state,
    usdcContractId,
    intentsContractId,
  };
}

export const FAKE_RELAYER_ACCOUNT = "ee".repeat(32);

/**
 * A gas relayer that only records which accounts it was asked to activate.
 * For anything that relays, use `nearRelayerOnFakeChain`.
 */
export function makeFakeNearRelayer() {
  const activated: string[] = [];
  let failures = 0;
  const state = {
    activated,
    /** The next `times` activations fail before doing anything. */
    failNext(times = 1) {
      failures = times;
    },
  };
  const unsupported = Effect.fail(
    new NearRelayerError({
      message: "the fake gas relayer doesn't relay: use nearRelayerOnFakeChain",
    }),
  );
  const service: NearRelayerShape = {
    accountId: FAKE_RELAYER_ACCOUNT,
    activateAccount: (accountId) => {
      if (failures > 0) {
        failures -= 1;
        return Effect.fail(
          new NearRelayerError({ message: "fake activation failure" }),
        );
      }
      activated.push(accountId);
      return Effect.void;
    },
    relayDelegate: () => unsupported,
    registerUsdcAccount: () => unsupported,
    sendUsdc: () => unsupported,
    awaitOutcome: () => Effect.succeed(null),
  };
  return { layer: Layer.succeed(NearRelayer, service), state };
}

/**
 * The real gas relayer, signing with a wallet in the fake Privy and sending
 * to the fake chain, where its account already exists.
 */
export function nearRelayerOnFakeChain(
  privy: ReturnType<typeof makeFakePrivyWallets>["state"],
  rpc: ReturnType<typeof makeFakeNearRpc>,
) {
  const wallet = privy.addNearWallet("gas-relayer");
  rpc.state.createAccount(wallet.accountId);
  const service = makeNearRelayer({
    accountId: wallet.accountId,
    signer: privy.nearSigner(wallet),
    rpc: rpc.service,
    usdcContractId: rpc.usdcContractId,
    intentsContractId: rpc.intentsContractId,
    outcomePolling: { attempts: 2, interval: 0 },
  });
  return {
    layer: Layer.succeed(NearRelayer, service),
    service,
    accountId: wallet.accountId,
  };
}
