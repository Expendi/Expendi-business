import type { ConfigError, Duration } from "effect";
import type { Action, SignedDelegate, Signer } from "near-api-js";
import { Config, Context, Data, Effect, Layer } from "effect";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
} from "near-api-js";

import type { NearRpcError, NearRpcShape } from "./near-rpc.js";
import type { NearTransactionOutcome } from "./near.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { NearRpc } from "./near-rpc.js";
import {
  isImplicitNearAccount,
  NearChain,
  usdcStorageDepositAction,
  usdcTransferAction,
} from "./near.js";

export class NearRelayerError extends Data.TaggedError("NearRelayerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NearRelayerShape {
  /** The gas relayer's own account, which signs every transaction it sends. */
  readonly accountId: string;
  /**
   * Makes a company account usable: creates it on chain if it doesn't exist
   * and registers it with the USDC contract if it isn't registered. Each
   * step first asks the chain, so calling this again does nothing more.
   * Succeeds only once the chain shows both.
   */
  readonly activateAccount: (
    accountId: string,
  ) => Effect.Effect<void, NearRelayerError | NearRpcError>;
  /**
   * Sends a company wallet's signed delegate action, paying its gas.
   * `beforeBroadcast` is given the relayer transaction's hash and runs to
   * completion before anything is broadcast, so the hash can be saved while
   * it is still certain the transaction hasn't been sent. A failure after
   * that point doesn't mean the transaction wasn't accepted.
   */
  readonly relayDelegate: <E, R>(input: {
    readonly signedDelegate: SignedDelegate;
    readonly beforeBroadcast: (txHash: string) => Effect.Effect<void, E, R>;
  }) => Effect.Effect<
    { readonly txHash: string },
    E | NearRelayerError | NearRpcError,
    R
  >;
  /**
   * Registers any account with the USDC contract, paying its one-time
   * storage deposit, whether or not the account exists on chain yet: a
   * 1Click deposit address has to be registered by whoever pays it. It asks
   * the chain first and registers with `registration_only`, so calling it
   * again costs nothing. Succeeds only once the chain shows the account
   * registered. `beforeBroadcast` is as for `relayDelegate`; `txHash` is
   * null when the account was registered already.
   */
  readonly registerUsdcAccount: <E, R>(input: {
    readonly accountId: string;
    readonly beforeBroadcast: (txHash: string) => Effect.Effect<void, E, R>;
  }) => Effect.Effect<
    { readonly txHash: string | null },
    E | NearRelayerError | NearRpcError,
    R
  >;
  /**
   * Sends USDC the relayer itself holds: the cover for what a company
   * wallet's 1Click quote costs beyond what it delivers. Each call builds a
   * new transaction, so the caller must make a retry safe: `beforeBroadcast`
   * is given the hash before anything is broadcast, and a caller that saved
   * a hash never calls again until `awaitOutcome` shows that transaction
   * failed.
   */
  readonly sendUsdc: <E, R>(input: {
    readonly to: string;
    /** USDC base units. */
    readonly amount: bigint;
    readonly beforeBroadcast: (txHash: string) => Effect.Effect<void, E, R>;
  }) => Effect.Effect<
    { readonly txHash: string },
    E | NearRelayerError | NearRpcError,
    R
  >;
  /**
   * Waits a short while for a transaction this relayer sent to become
   * final. Null if it still isn't: that says nothing about its outcome.
   */
  readonly awaitOutcome: (
    txHash: string,
  ) => Effect.Effect<NearTransactionOutcome | null, NearRpcError>;
}

export class NearRelayer extends Context.Tag("NearRelayer")<
  NearRelayer,
  NearRelayerShape
>() {}

export interface OutcomePolling {
  readonly attempts: number;
  readonly interval: Duration.DurationInput;
}

/** A NEAR transaction is usually final within a few seconds. */
const DEFAULT_OUTCOME_POLLING: OutcomePolling = {
  attempts: 30,
  interval: "1 second",
};

/**
 * Sent to a company account to create it. An implicit account exists only
 * once it has received NEAR, and every USDC transfer it later makes must
 * attach 1 yoctoNEAR of its own, which a relayer can't pay for it. A
 * thousandth of a NEAR covers that for longer than the account will live.
 */
export const ACCOUNT_CREATION_YOCTO = 1_000_000_000_000_000_000_000n;

export function makeNearRelayer(deps: {
  readonly accountId: string;
  readonly signer: Signer;
  readonly rpc: NearRpcShape;
  readonly usdcContractId: string;
  readonly outcomePolling?: OutcomePolling;
}): NearRelayerShape {
  const { accountId, signer, rpc, usdcContractId } = deps;
  const polling = deps.outcomePolling ?? DEFAULT_OUTCOME_POLLING;
  // One at a time: two transactions built from the same reading of the
  // relayer's nonce would share it, and the chain accepts only one of them.
  const oneAtATime = Effect.unsafeMakeSemaphore(1);
  // The chain reports a nonce as used only once its transaction is in a
  // block, which is later than the next relay may start.
  let lastNonceUsed = 0n;

  const submit = <E, R>(
    receiverId: string,
    transactionActions: Action[],
    beforeBroadcast: (txHash: string) => Effect.Effect<void, E, R>,
  ): Effect.Effect<string, E | NearRelayerError | NearRpcError, R> =>
    oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        const publicKey = yield* Effect.promise(() => signer.getPublicKey());
        const [chainNonce, block] = yield* Effect.all([
          rpc.accessKeyNonce({ accountId, publicKey: publicKey.toString() }),
          rpc.finalBlock(),
        ]);
        if (chainNonce === null) {
          return yield* Effect.fail(
            new NearRelayerError({
              message: `The gas relayer account ${accountId} doesn't exist on chain yet: send it NEAR first`,
            }),
          );
        }
        const nonce =
          (chainNonce > lastNonceUsed ? chainNonce : lastNonceUsed) + 1n;
        const signed = yield* Effect.tryPromise({
          try: () =>
            signer.signTransaction(
              createTransaction(
                accountId,
                publicKey,
                receiverId,
                nonce,
                transactionActions,
                baseDecode(block.hash),
              ),
            ),
          catch: (cause) =>
            new NearRelayerError({
              message: "The gas relayer could not sign its transaction",
              cause,
            }),
        });
        lastNonceUsed = nonce;
        const txHash = baseEncode(signed.txHash);
        yield* beforeBroadcast(txHash);
        yield* rpc.broadcast(signed.signedTransaction.encode());
        return txHash;
      }),
    );

  const awaitOutcome = (
    txHash: string,
    attemptsLeft = polling.attempts,
  ): Effect.Effect<NearTransactionOutcome | null, NearRpcError> => {
    const again = Effect.sleep(polling.interval).pipe(
      Effect.zipRight(
        Effect.suspend(() => awaitOutcome(txHash, attemptsLeft - 1)),
      ),
    );
    return rpc.transactionOutcome(txHash, accountId).pipe(
      Effect.matchEffect({
        onSuccess: (outcome) =>
          outcome !== null || attemptsLeft <= 1
            ? Effect.succeed(outcome)
            : again,
        onFailure: (error) => (attemptsLeft <= 1 ? Effect.fail(error) : again),
      }),
    );
  };

  /** Sends one of the relayer's own transactions and waits for it to succeed. */
  const execute = (
    what: string,
    receiverId: string,
    transactionActions: Action[],
  ): Effect.Effect<void, NearRelayerError | NearRpcError> =>
    submit(receiverId, transactionActions, () => Effect.void).pipe(
      Effect.flatMap((txHash) => awaitOutcome(txHash)),
      Effect.flatMap((outcome) =>
        outcome?.succeeded === true
          ? Effect.void
          : Effect.fail(
              new NearRelayerError({
                message:
                  outcome === null
                    ? `The gas relayer's transaction to ${what} isn't final yet`
                    : `The gas relayer's transaction to ${what} failed on chain (${outcome.txHash})`,
              }),
            ),
      ),
    );

  return {
    accountId,

    activateAccount: (companyAccountId) =>
      Effect.gen(function* () {
        if (!isImplicitNearAccount(companyAccountId)) {
          return yield* Effect.fail(
            new NearRelayerError({
              message: `Not an implicit NEAR account: ${companyAccountId}`,
            }),
          );
        }
        if (!(yield* rpc.accountExists(companyAccountId))) {
          yield* execute(`create ${companyAccountId}`, companyAccountId, [
            actions.transfer(ACCOUNT_CREATION_YOCTO),
          ]);
        }
        if (!(yield* rpc.usdcStorageRegistered(companyAccountId))) {
          yield* execute(
            `register ${companyAccountId} with USDC`,
            usdcContractId,
            [usdcStorageDepositAction(companyAccountId)],
          );
        }
        const [exists, registered] = yield* Effect.all([
          rpc.accountExists(companyAccountId),
          rpc.usdcStorageRegistered(companyAccountId),
        ]);
        if (!exists || !registered) {
          return yield* Effect.fail(
            new NearRelayerError({
              message: `The chain doesn't show ${companyAccountId} as created and registered with USDC yet`,
            }),
          );
        }
      }),

    relayDelegate: ({ signedDelegate, beforeBroadcast }) => {
      const { senderId, receiverId } = signedDelegate.delegateAction;
      // A company wallet only ever talks to the USDC contract. Anything else
      // reaching the relayer is a bug upstream, and gas isn't spent on it.
      if (receiverId !== usdcContractId) {
        return Effect.fail(
          new NearRelayerError({
            message: `Refusing to relay a delegate action for ${receiverId}: only USDC is relayed`,
          }),
        );
      }
      return submit(
        senderId,
        [actions.signedDelegate(signedDelegate)],
        beforeBroadcast,
      ).pipe(Effect.map((txHash) => ({ txHash })));
    },

    registerUsdcAccount: ({ accountId: target, beforeBroadcast }) =>
      Effect.gen(function* () {
        if (yield* rpc.usdcStorageRegistered(target)) return { txHash: null };
        const action = yield* Effect.try({
          try: () => usdcStorageDepositAction(target),
          catch: () =>
            new NearRelayerError({
              message: `Not a NEAR account ID: ${target}`,
            }),
        });
        const txHash = yield* submit(usdcContractId, [action], beforeBroadcast);
        yield* awaitOutcome(txHash);
        if (!(yield* rpc.usdcStorageRegistered(target))) {
          return yield* Effect.fail(
            new NearRelayerError({
              message: `The chain doesn't show ${target} as registered with USDC yet`,
            }),
          );
        }
        return { txHash };
      }),

    sendUsdc: ({ to, amount, beforeBroadcast }) =>
      Effect.try({
        try: () => usdcTransferAction(to, amount),
        catch: () =>
          new NearRelayerError({
            message: `The gas relayer can't send ${amount} USDC base units to ${to}`,
          }),
      }).pipe(
        Effect.flatMap((action) =>
          submit(usdcContractId, [action], beforeBroadcast),
        ),
        Effect.map((txHash) => ({ txHash })),
      ),

    awaitOutcome: (txHash) => awaitOutcome(txHash),
  };
}

/**
 * The gas relayer is one Expendi-owned Privy NEAR wallet
 * (scripts/setup-near-relayer.ts). The API signs for it with the same
 * runtime key it signs for company wallets with.
 */
export const NearRelayerLive: Layer.Layer<
  NearRelayer,
  ConfigError.ConfigError,
  PrivyWallets | NearRpc | NearChain
> = Layer.effect(
  NearRelayer,
  Effect.gen(function* () {
    const privy = yield* PrivyWallets;
    const rpc = yield* NearRpc;
    const chain = yield* NearChain;
    const privyWalletId = yield* Config.string("NEAR_RELAYER_PRIVY_WALLET_ID");
    const accountId = yield* Config.string("NEAR_RELAYER_ACCOUNT_ID").pipe(
      Config.validate({
        message:
          "NEAR_RELAYER_ACCOUNT_ID must be the relayer wallet's 64-hex account ID",
        validation: isImplicitNearAccount,
      }),
    );
    return makeNearRelayer({
      accountId,
      signer: privy.nearSigner({ privyWalletId, accountId }),
      rpc,
      usdcContractId: chain.usdcContractId,
    });
  }),
);
