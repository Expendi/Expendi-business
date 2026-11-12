import type { PrivyClient, Wallet as PrivyWallet } from "@privy-io/node";
import type { ConfigError } from "effect";
import type { PublicKey } from "near-api-js";
import { APIError } from "@privy-io/node";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { Signer } from "near-api-js";

import {
  BASE_CHAIN_ID,
  USDC_BASE_ADDRESS,
  usdcTransferCalldata,
} from "../chain/base.js";
import { implicitAccountPublicKey } from "../chain/near.js";
import { PrivyClientLive, PrivyClientService } from "../privy/privy-client.js";
import { companyWalletPolicyRules } from "./wallet-policy.js";

export class PrivyWalletError extends Data.TaggedError("PrivyWalletError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A send Privy refused outright (a 4xx, including a policy violation): no
 * transaction exists and nothing left the wallet.
 */
export class SendRefused extends Data.TaggedError("SendRefused")<{
  readonly message: string;
  readonly status: number;
  readonly policyViolation: boolean;
}> {}

/**
 * A send whose outcome is unknown (a timeout, a 5xx, a lost reply). The
 * transaction may have been broadcast: never send again automatically.
 */
export class SendOutcomeUnknown extends Data.TaggedError("SendOutcomeUnknown")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface SendUsdcInput {
  readonly privyWalletId: string;
  readonly to: string;
  /** USDC base units. */
  readonly amount: bigint;
  /** Stable per payout, so Privy replays rather than repeats a retry. */
  readonly idempotencyKey: string;
}

export interface SentTransaction {
  /** Null when Privy accepted a sponsored send but hasn't a hash yet. */
  readonly txHash: string | null;
  readonly privyTransactionId: string | null;
}

/** The parts of a Privy wallet the API checks and stores. */
export interface PrivyWalletRecord {
  readonly id: string;
  readonly address: string;
  readonly ownerId: string | null;
  readonly policyIds: readonly string[];
  readonly signerIds: readonly string[];
}

export interface CreatePolicyInput {
  readonly name: string;
  readonly perTransactionMaxUsdc: bigint;
  readonly ownerQuorumId: string;
  readonly idempotencyKey: string;
}

export interface CreateWalletInput {
  /** Write-once in Privy; lets a retry find a wallet whose ID was lost. */
  readonly externalId: string;
  readonly displayName: string;
  readonly policyId: string;
  readonly ownerQuorumId: string;
  readonly signerQuorumId: string;
  readonly idempotencyKey: string;
}

/** A NEAR wallet takes no policy: Privy has no policy conditions for NEAR. */
export type CreateNearWalletInput = Omit<CreateWalletInput, "policyId">;

export interface NearSigningWallet {
  readonly privyWalletId: string;
  /** The wallet's 64-hex implicit account ID, which is its public key. */
  readonly accountId: string;
}

export interface PrivyWalletsShape {
  readonly createPolicy: (
    input: CreatePolicyInput,
  ) => Effect.Effect<{ readonly policyId: string }, PrivyWalletError>;
  /** An Ethereum wallet bound by a policy: a company's transit wallet. */
  readonly createWallet: (
    input: CreateWalletInput,
  ) => Effect.Effect<PrivyWalletRecord, PrivyWalletError>;
  readonly findWalletByExternalId: (
    externalId: string,
  ) => Effect.Effect<PrivyWalletRecord | null, PrivyWalletError>;
  /** A NEAR wallet: a company wallet, or the gas relayer. */
  readonly createNearWallet: (
    input: CreateNearWalletInput,
  ) => Effect.Effect<PrivyWalletRecord, PrivyWalletError>;
  readonly findNearWalletByExternalId: (
    externalId: string,
  ) => Effect.Effect<PrivyWalletRecord | null, PrivyWalletError>;
  /**
   * Signs for a NEAR wallet as the API's signer. Privy checks nothing about
   * what is signed, so whoever calls this decides what the wallet may do.
   * Signing rejects with whatever Privy threw: see `nearSigningRefusal`.
   */
  readonly nearSigner: (wallet: NearSigningWallet) => Signer;
  /**
   * Sends USDC on Base from a transit wallet as the API's signer, gas
   * sponsored by Expendi. The wallet's policy is the last word on whether
   * it is allowed.
   */
  readonly sendUsdc: (
    input: SendUsdcInput,
  ) => Effect.Effect<SentTransaction, SendRefused | SendOutcomeUnknown>;
  /**
   * The Base hash of a send Privy accepted without one, once the send is
   * confirmed on chain. Null while it isn't, or when the transaction isn't
   * that wallet's: a hash is only ever taken from Privy's own record of the
   * send, never guessed from the chain.
   */
  readonly transactionHash: (input: {
    readonly privyWalletId: string;
    readonly privyTransactionId: string;
  }) => Effect.Effect<string | null, PrivyWalletError>;
}

export class PrivyWallets extends Context.Tag("PrivyWallets")<
  PrivyWallets,
  PrivyWalletsShape
>() {}

const toRecord = (wallet: PrivyWallet): PrivyWalletRecord => ({
  id: wallet.id,
  address: wallet.address,
  ownerId: wallet.owner_id,
  policyIds: wallet.policy_ids,
  signerIds: wallet.additional_signers.map((signer) => signer.signer_id),
});

const privyCall = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PrivyWalletError({ message, cause }),
  });

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A hash Privy may later replace or that reverted is no proof of a transfer. */
const SETTLED_ON_CHAIN = new Set(["confirmed", "finalized"]);

/** The refusal in `cause`, if Privy answered with a definite no. */
function refusalIn(cause: unknown): SendRefused | null {
  if (
    cause instanceof APIError &&
    typeof cause.status === "number" &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 408 &&
    cause.status !== 409 &&
    cause.status !== 429
  ) {
    return new SendRefused({
      message: cause.message,
      status: cause.status,
      policyViolation: /policy_violation/i.test(cause.message),
    });
  }
  return null;
}

function classifySendFailure(cause: unknown): SendRefused | SendOutcomeUnknown {
  return (
    refusalIn(cause) ??
    new SendOutcomeUnknown({
      message: "Privy send outcome unknown",
      cause,
    })
  );
}

/**
 * Why a NEAR signing failed. Unlike a Base send, Privy only signs here and
 * the API broadcasts, so a failure of any kind means no signature exists
 * outside Privy and nothing can have moved: a refusal is final, anything
 * else is safe to try again.
 */
export function nearSigningFailure(
  cause: unknown,
): SendRefused | PrivyWalletError {
  return (
    refusalIn(cause) ??
    new PrivyWalletError({ message: "Privy did not sign for NEAR", cause })
  );
}

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/**
 * A NEAR account whose key Privy holds, signing as the API's runtime key
 * (proven in scripts/spike-privy-near.ts). A NEAR wallet's address is its
 * implicit account ID, and that ID is the hex of its ed25519 public key.
 */
export class PrivyNearSigner extends Signer {
  private readonly publicKey: PublicKey;

  constructor(
    private readonly client: PrivyClient,
    private readonly runtimeAuthorizationKey: Redacted.Redacted,
    private readonly wallet: NearSigningWallet,
  ) {
    super();
    this.publicKey = implicitAccountPublicKey(wallet.accountId);
  }

  getPublicKey(): Promise<PublicKey> {
    return Promise.resolve(this.publicKey);
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const signed = await this.client
      .wallets()
      .rawSign(this.wallet.privyWalletId, {
        params: { hash: `0x${Buffer.from(bytes).toString("hex")}` },
        authorization_context: {
          authorization_private_keys: [
            Redacted.value(this.runtimeAuthorizationKey),
          ],
        },
      });
    const signature = hexToBytes(signed.signature);
    // A signature from any other key would be relayed and then rejected on
    // chain; catching it here keeps it from ever being saved as a send.
    if (!this.publicKey.verify(bytes, signature)) {
      throw new Error(
        `Privy wallet ${this.wallet.privyWalletId} did not sign as account ${this.wallet.accountId}`,
      );
    }
    return signature;
  }
}

type PrivyChainType = "ethereum" | "near";

const findWallet = (
  client: PrivyClient,
  externalId: string,
  chainType: PrivyChainType,
) =>
  privyCall("Failed to look up the wallet", async () => {
    for await (const wallet of client
      .wallets()
      .list({ external_id: externalId, chain_type: chainType })) {
      return wallet;
    }
    return null;
  }).pipe(Effect.map((wallet) => (wallet ? toRecord(wallet) : null)));

export const makePrivyWallets = (
  client: PrivyClient,
  runtimeAuthorizationKey: Redacted.Redacted,
): PrivyWalletsShape => ({
  createPolicy: (input) =>
    privyCall("Failed to create the wallet policy", () =>
      client.policies().create({
        chain_type: "ethereum",
        version: "1.0",
        name: input.name,
        owner_id: input.ownerQuorumId,
        rules: companyWalletPolicyRules(input.perTransactionMaxUsdc),
        idempotency_key: input.idempotencyKey,
      }),
    ).pipe(Effect.map((policy) => ({ policyId: policy.id }))),

  createWallet: (input) =>
    privyCall("Failed to create the wallet", () =>
      client.wallets().create({
        chain_type: "ethereum",
        external_id: input.externalId,
        display_name: input.displayName,
        owner_id: input.ownerQuorumId,
        policy_ids: [input.policyId],
        additional_signers: [{ signer_id: input.signerQuorumId }],
        idempotency_key: input.idempotencyKey,
      }),
    ).pipe(Effect.map(toRecord)),

  findWalletByExternalId: (externalId) =>
    findWallet(client, externalId, "ethereum"),

  createNearWallet: (input) =>
    privyCall("Failed to create the NEAR wallet", () =>
      client.wallets().create({
        chain_type: "near",
        external_id: input.externalId,
        display_name: input.displayName,
        owner_id: input.ownerQuorumId,
        additional_signers: [{ signer_id: input.signerQuorumId }],
        idempotency_key: input.idempotencyKey,
      }),
    ).pipe(Effect.map(toRecord)),

  findNearWalletByExternalId: (externalId) =>
    findWallet(client, externalId, "near"),

  nearSigner: (wallet) =>
    new PrivyNearSigner(client, runtimeAuthorizationKey, wallet),

  sendUsdc: (input) =>
    Effect.tryPromise({
      try: () =>
        client
          .wallets()
          .ethereum()
          .sendTransaction(input.privyWalletId, {
            caip2: `eip155:${BASE_CHAIN_ID}`,
            sponsor: true,
            params: {
              transaction: {
                to: USDC_BASE_ADDRESS,
                data: usdcTransferCalldata(input.to, input.amount),
                chain_id: BASE_CHAIN_ID,
              },
            },
            idempotency_key: input.idempotencyKey,
            authorization_context: {
              authorization_private_keys: [
                Redacted.value(runtimeAuthorizationKey),
              ],
            },
          }),
      catch: classifySendFailure,
    }).pipe(
      Effect.map((sent) => ({
        txHash: TX_HASH.test(sent.hash) ? sent.hash.toLowerCase() : null,
        privyTransactionId: sent.transaction_id ?? null,
      })),
    ),

  transactionHash: ({ privyWalletId, privyTransactionId }) =>
    privyCall("Privy didn't return the transaction", () =>
      client.transactions().get(privyTransactionId),
    ).pipe(
      Effect.map((transaction) => {
        const hash = transaction.transaction_hash;
        return transaction.wallet_id === privyWalletId &&
          transaction.caip2 === `eip155:${BASE_CHAIN_ID}` &&
          SETTLED_ON_CHAIN.has(transaction.status) &&
          hash !== null &&
          TX_HASH.test(hash)
          ? hash.toLowerCase()
          : null;
      }),
    ),
});

export const PrivyWalletsLive: Layer.Layer<
  PrivyWallets,
  ConfigError.ConfigError
> = Layer.effect(
  PrivyWallets,
  Effect.gen(function* () {
    const client = yield* PrivyClientService;
    // The API's signer key (scripts/setup-privy-keys.ts); never the
    // management key.
    const runtimeKey = yield* Config.redacted(
      "PRIVY_RUNTIME_AUTHORIZATION_KEY",
    );
    return makePrivyWallets(client, runtimeKey);
  }),
).pipe(Layer.provide(PrivyClientLive));
