import type { PrivyClient, Wallet as PrivyWallet } from "@privy-io/node";
import type { Wallets } from "@privy-io/node/resources";
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
import {
  companyWalletPolicyRules,
  treasuryWalletPolicyRules,
} from "./wallet-policy.js";

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

export interface CreateTreasuryPolicyInput extends CreatePolicyInput {
  /** Privy's ID for the Earn vault (not the contract address). */
  readonly vaultId: string;
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

/** What Privy reports for an Earn action: only `pending` may still change. */
export type EarnActionStatus = "pending" | "succeeded" | "rejected" | "failed";

export interface EarnCallInput {
  readonly privyWalletId: string;
  /** Privy's ID for the vault (not the contract address). */
  readonly vaultId: string;
  /** USDC base units, always sent as `raw_amount`: a policy rule on `amount` wouldn't match. */
  readonly rawAmount: bigint;
  /**
   * Sent as both Privy's `reference_id` and its idempotency key, so a repeat
   * after a lost answer returns the same action and can't act twice.
   */
  readonly referenceId: string;
}

/** An Earn action as Privy reports it, with the hash of its transaction if it has one. */
export interface EarnActionRecord {
  readonly actionId: string;
  readonly status: EarnActionStatus;
  readonly rawAmount: bigint;
  readonly shareAmount: bigint | null;
  /** The step's `bundle_transaction_hash`: Privy sends Earn calls as user operations. */
  readonly txHash: string | null;
  /** Privy's reason when the action was rejected or failed. */
  readonly failureReason: string | null;
}

export interface VaultPosition {
  /** What the position is worth now. Right at once, unlike the totals. */
  readonly assetsInVault: bigint;
  readonly sharesInVault: bigint;
  /** Count Earn calls only and lag a move by 10 to 20 seconds. */
  readonly totalDeposited: bigint;
  readonly totalWithdrawn: bigint;
}

export interface VaultDetails {
  readonly name: string;
  /** The rate to show, in basis points after Expendi's share; null if Privy has none. */
  readonly userApyBps: number | null;
  readonly availableLiquidityUsd: number | null;
}

export interface PrivyWalletsShape {
  readonly createPolicy: (
    input: CreatePolicyInput,
  ) => Effect.Effect<{ readonly policyId: string }, PrivyWalletError>;
  /** A Treasury wallet's policy: Earn into one vault, and the capped transfer. */
  readonly createTreasuryPolicy: (
    input: CreateTreasuryPolicyInput,
  ) => Effect.Effect<{ readonly policyId: string }, PrivyWalletError>;
  /**
   * An Ethereum wallet bound by a policy: a company's transit wallet, or its
   * Treasury wallet.
   */
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
  /**
   * Deposits from a Treasury wallet into the vault. A `SendRefused` (an
   * unknown vault is a 404, an amount over the wallet's balance a 400)
   * means nothing was signed; `SendOutcomeUnknown` means it may have been,
   * so the same input is sent again, never a new reference.
   */
  readonly earnDeposit: (
    input: EarnCallInput,
  ) => Effect.Effect<EarnActionRecord, SendRefused | SendOutcomeUnknown>;
  /** The same for a withdrawal from the vault; unused until a move to wallet. */
  readonly earnWithdraw: (
    input: EarnCallInput,
  ) => Effect.Effect<EarnActionRecord, SendRefused | SendOutcomeUnknown>;
  /** An Earn action's status, with the transaction hash if it has one. */
  readonly getWalletAction: (input: {
    readonly privyWalletId: string;
    readonly actionId: string;
  }) => Effect.Effect<EarnActionRecord, PrivyWalletError>;
  readonly vaultPosition: (input: {
    readonly privyWalletId: string;
    readonly vaultId: string;
  }) => Effect.Effect<VaultPosition, PrivyWalletError>;
  readonly vaultDetails: (
    vaultId: string,
  ) => Effect.Effect<VaultDetails, PrivyWalletError>;
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

const toAmount = (value: string | null | undefined): bigint | null =>
  value === null || value === undefined || !/^\d+$/.test(value)
    ? null
    : BigInt(value);

/**
 * An Earn action in the shape the API keeps. Only a step of type
 * `evm_user_operation` carries the hash, and only when asked for with
 * `include=steps`.
 */
function toEarnAction(action: Wallets.WalletActionResponse): EarnActionRecord {
  const earn =
    action.type === "earn_deposit" || action.type === "earn_withdraw"
      ? action
      : null;
  const hashes = (action.steps ?? []).flatMap((step) =>
    step.type === "evm_user_operation" && step.bundle_transaction_hash !== null
      ? [step.bundle_transaction_hash]
      : [],
  );
  const hash = hashes.at(-1);
  return {
    actionId: action.id,
    status: action.status,
    rawAmount: toAmount(earn?.raw_amount) ?? 0n,
    shareAmount: toAmount(earn?.share_amount),
    txHash:
      hash !== undefined && TX_HASH.test(hash) ? hash.toLowerCase() : null,
    failureReason: action.failure_reason?.message ?? null,
  };
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

const earnCall = (
  client: PrivyClient,
  runtimeAuthorizationKey: Redacted.Redacted,
  kind: "deposit" | "withdraw",
  input: EarnCallInput,
): Effect.Effect<EarnActionRecord, SendRefused | SendOutcomeUnknown> => {
  const params = {
    vault_id: input.vaultId,
    raw_amount: input.rawAmount.toString(),
    reference_id: input.referenceId,
    idempotency_key: input.referenceId,
    authorization_context: {
      authorization_private_keys: [Redacted.value(runtimeAuthorizationKey)],
    },
  };
  const earn = client.wallets().earn().ethereum();
  return Effect.tryPromise({
    try: (): Promise<Wallets.WalletActionResponse> =>
      kind === "deposit"
        ? earn.deposit(input.privyWalletId, params)
        : earn.withdraw(input.privyWalletId, params),
    catch: classifySendFailure,
  }).pipe(Effect.map(toEarnAction));
};

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

  createTreasuryPolicy: (input) =>
    privyCall("Failed to create the Treasury policy", () =>
      client.policies().create({
        chain_type: "ethereum",
        version: "1.0",
        name: input.name,
        owner_id: input.ownerQuorumId,
        rules: treasuryWalletPolicyRules(
          input.vaultId,
          input.perTransactionMaxUsdc,
        ),
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

  earnDeposit: (input) =>
    earnCall(client, runtimeAuthorizationKey, "deposit", input),

  earnWithdraw: (input) =>
    earnCall(client, runtimeAuthorizationKey, "withdraw", input),

  getWalletAction: (input) =>
    privyCall("Failed to read the Earn action", () =>
      client.wallets().actions.get(input.actionId, {
        wallet_id: input.privyWalletId,
        include: "steps",
      }),
    ).pipe(Effect.map(toEarnAction)),

  vaultPosition: (input) =>
    privyCall("Failed to read the vault position", () =>
      client
        .wallets()
        .earn()
        .ethereum()
        .vaultPosition(input.privyWalletId, { vault_id: input.vaultId }),
    ).pipe(
      Effect.map((position) => ({
        assetsInVault: toAmount(position.assets_in_vault) ?? 0n,
        sharesInVault: toAmount(position.shares_in_vault) ?? 0n,
        totalDeposited: toAmount(position.total_deposited) ?? 0n,
        totalWithdrawn: toAmount(position.total_withdrawn) ?? 0n,
      })),
    ),

  vaultDetails: (vaultId) =>
    privyCall("Failed to read the vault", () =>
      client.wallets().earn().ethereum().vaultDetails(vaultId),
    ).pipe(
      Effect.map((vault) => ({
        name: vault.name,
        userApyBps: vault.user_apy ?? null,
        availableLiquidityUsd: vault.available_liquidity_usd ?? null,
      })),
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
