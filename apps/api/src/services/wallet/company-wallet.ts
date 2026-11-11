import type { SQL } from "drizzle-orm";
import type { ConfigError } from "effect";
import { and, eq, isNull } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer } from "effect";

import { MAIN_CHAIN } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { NewWallet, Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AlchemyNotifyError } from "../alchemy/alchemy-webhook.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { NearRelayerError } from "../chain/near-relayer.js";
import type { NearRpcError } from "../chain/near-rpc.js";
import type { PrivyWalletError, PrivyWalletRecord } from "./privy-wallets.js";
import { wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AlchemyWebhook } from "../alchemy/alchemy-webhook.js";
import { AuditLog } from "../audit/audit-log.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { isImplicitNearAccount } from "../chain/near.js";
import { PrivyWallets } from "./privy-wallets.js";

const USDC_PER_WHOLE_DOLLAR = 1_000_000n;

export interface WalletSettingsShape {
  /** Owns every company wallet, transit wallet and policy; its private key is never in the API. */
  readonly managementQuorumId: string;
  /** The API's signer on every company wallet and transit wallet. */
  readonly runtimeSignerId: string;
  /**
   * The most one transaction may move, in USDC base units: written into each
   * new transit wallet's policy, and enforced by the API on the company wallet.
   */
  readonly defaultPerTransactionMaxUsdc: bigint;
}

export class WalletSettings extends Context.Tag("WalletSettings")<
  WalletSettings,
  WalletSettingsShape
>() {}

export const WalletSettingsLive: Layer.Layer<
  WalletSettings,
  ConfigError.ConfigError
> = Layer.effect(
  WalletSettings,
  Effect.gen(function* () {
    const managementQuorumId = yield* Config.string(
      "PRIVY_MANAGEMENT_QUORUM_ID",
    );
    const runtimeSignerId = yield* Config.string("PRIVY_RUNTIME_SIGNER_ID");
    // Whole USDC. 3,100 sits just above Paycrest's largest KES order plus
    // its fee (Dennis, 2026-11-01); ops raise it per company with the
    // management key.
    const perTransactionMaxWholeUsdc = yield* Config.withDefault(
      Config.integer("WALLET_PER_TRANSACTION_MAX_USDC").pipe(
        Config.validate({
          message: "WALLET_PER_TRANSACTION_MAX_USDC must be a positive integer",
          validation: (value) => value > 0,
        }),
      ),
      3_100,
    );
    return {
      managementQuorumId,
      runtimeSignerId,
      defaultPerTransactionMaxUsdc:
        BigInt(perTransactionMaxWholeUsdc) * USDC_PER_WHOLE_DOLLAR,
    };
  }),
);

/** A Privy wallet that doesn't have the owner, policy and signer we set. */
export class WalletMisconfigured extends Data.TaggedError(
  "WalletMisconfigured",
)<{
  readonly message: string;
  readonly privyWalletId: string;
}> {}

export type EnsureCompanyWalletError =
  | PrivyWalletError
  | AlchemyNotifyError
  | NearRelayerError
  | NearRpcError
  | WalletMisconfigured
  | DatabaseError;

export type EnsureCompanyWalletDeps =
  | DatabaseService
  | AuditLog
  | PrivyWallets
  | NearRelayer
  | AlchemyWebhook
  | WalletSettings;

/** The transit wallet's external ID in Privy; the company wallet's is the company ID itself. */
export const transitExternalId = (organizationId: string): string =>
  `transit-${organizationId}`;

const selectWallet = (tx: Transaction, organizationId: string) =>
  query(() =>
    tx
      .select()
      .from(wallets)
      .where(eq(wallets.organizationId, organizationId))
      .limit(1),
  ).pipe(
    Effect.flatMap(([wallet]) =>
      wallet
        ? Effect.succeed(wallet)
        : Effect.dieMessage("company wallet row vanished"),
    ),
  );

const saved = <A>(value: A | null, what: string): Effect.Effect<A> =>
  value === null
    ? Effect.dieMessage(`company wallet has no ${what} after it was saved`)
    : Effect.succeed(value);

/**
 * `record` if it is set up as expected. `policyId` is the one policy a
 * transit wallet must carry; a company wallet on NEAR carries none, because
 * Privy has no policy conditions for NEAR, and must instead be an implicit
 * account, which is the only kind the API can sign for.
 */
function checkPrivyWallet(
  record: PrivyWalletRecord,
  expected: {
    readonly policyId: string | null;
    readonly managementQuorumId: string;
    readonly runtimeSignerId: string;
  },
): Effect.Effect<PrivyWalletRecord, WalletMisconfigured> {
  const problems = [
    record.ownerId !== expected.managementQuorumId &&
      `owner is ${record.ownerId ?? "none"}`,
    expected.policyId !== null &&
      (record.policyIds.length !== 1 ||
        record.policyIds[0] !== expected.policyId) &&
      `policies are [${record.policyIds.join(", ")}]`,
    expected.policyId === null &&
      !isImplicitNearAccount(record.address) &&
      `address ${record.address} is not a NEAR implicit account`,
    !record.signerIds.includes(expected.runtimeSignerId) &&
      "the API is not a signer",
  ].filter((problem) => typeof problem === "string");
  return problems.length === 0
    ? Effect.succeed(record)
    : Effect.fail(
        new WalletMisconfigured({
          message: `Privy wallet ${record.id} is not set up as expected: ${problems.join("; ")}`,
          privyWalletId: record.id,
        }),
      );
}

/**
 * Gives a company its company wallet on NEAR and its transit wallet on Base
 * (spec §6.9, §7.1, docs/decisions/near-main-chain.md), safe to call any
 * number of times, concurrently or after a crash. Each step saves what it
 * made before the next begins and is keyed, so a retry resumes rather than
 * repeats:
 *
 * 1. the `wallets` row, unique per company;
 * 2. the company wallet in Privy, found by its external ID (the company ID)
 *    if an earlier attempt created it, otherwise created with an
 *    idempotency key, then checked for the expected owner and signer;
 * 3. the transit wallet's policy, created with an idempotency key;
 * 4. the transit wallet in Privy, found by its external ID or created the
 *    same way, then checked for the expected owner, policy and signer;
 * 5. the company wallet's account on chain: the gas relayer creates it and
 *    registers it with the USDC contract, doing only what the chain still
 *    lacks;
 * 6. activation, audited in the same transaction;
 * 7. the Alchemy webhook told to watch the transit address, so what
 *    arrives there on Base shows up.
 */
export function ensureCompanyWallet(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
}): Effect.Effect<Wallet, EnsureCompanyWalletError, EnsureCompanyWalletDeps> {
  const { organizationId, actor } = input;
  const scope = { organizationId };

  /**
   * Saves a step's result unless a concurrent attempt already did, and
   * returns the row either way, so both carry on from the same values.
   */
  const saveStep = (
    walletId: string,
    changes: Partial<NewWallet>,
    unless: SQL,
  ) =>
    withScope(scope, (tx) =>
      query(() =>
        tx
          .update(wallets)
          .set(changes)
          .where(and(eq(wallets.id, walletId), unless)),
      ).pipe(Effect.zipRight(selectWallet(tx, organizationId))),
    );

  return Effect.gen(function* () {
    const settings = yield* WalletSettings;
    const privy = yield* PrivyWallets;
    const relayer = yield* NearRelayer;
    const alchemy = yield* AlchemyWebhook;
    const audit = yield* AuditLog;

    let wallet = yield* withScope(scope, (tx) =>
      query(() =>
        tx
          .insert(wallets)
          .values({
            organizationId,
            perTransactionMaxUsdc: settings.defaultPerTransactionMaxUsdc,
          })
          .onConflictDoNothing({ target: wallets.organizationId }),
      ).pipe(Effect.zipRight(selectWallet(tx, organizationId))),
    );

    if (wallet.status === "creating") {
      if (wallet.privyWalletId === null) {
        const existing =
          yield* privy.findNearWalletByExternalId(organizationId);
        const companyWallet = yield* checkPrivyWallet(
          existing ??
            (yield* privy.createNearWallet({
              externalId: organizationId,
              displayName: `company-${organizationId}`,
              ownerQuorumId: settings.managementQuorumId,
              signerQuorumId: settings.runtimeSignerId,
              idempotencyKey: `company-wallet-${wallet.id}`,
            })),
          { ...settings, policyId: null },
        );
        wallet = yield* saveStep(
          wallet.id,
          {
            chain: MAIN_CHAIN,
            privyWalletId: companyWallet.id,
            address: companyWallet.address,
          },
          isNull(wallets.privyWalletId),
        );
      }
      const accountId = yield* saved(wallet.address, "account ID");

      if (wallet.privyPolicyId === null) {
        const created = yield* privy.createPolicy({
          name: `transit-${organizationId}`,
          perTransactionMaxUsdc: wallet.perTransactionMaxUsdc,
          ownerQuorumId: settings.managementQuorumId,
          idempotencyKey: `wallet-policy-${wallet.id}`,
        });
        wallet = yield* saveStep(
          wallet.id,
          { privyPolicyId: created.policyId },
          isNull(wallets.privyPolicyId),
        );
      }
      const policyId = yield* saved(wallet.privyPolicyId, "transit policy");

      if (wallet.transitPrivyWalletId === null) {
        const externalId = transitExternalId(organizationId);
        const existing = yield* privy.findWalletByExternalId(externalId);
        const transitWallet = yield* checkPrivyWallet(
          existing ??
            (yield* privy.createWallet({
              externalId,
              displayName: `transit-${organizationId}`,
              policyId,
              ownerQuorumId: settings.managementQuorumId,
              signerQuorumId: settings.runtimeSignerId,
              idempotencyKey: `transit-wallet-${wallet.id}`,
            })),
          { ...settings, policyId },
        );
        wallet = yield* saveStep(
          wallet.id,
          {
            transitPrivyWalletId: transitWallet.id,
            transitAddress: transitWallet.address,
          },
          isNull(wallets.transitPrivyWalletId),
        );
      }

      if (wallet.onchainActivatedAt === null) {
        yield* relayer.activateAccount(accountId);
        wallet = yield* saveStep(
          wallet.id,
          { onchainActivatedAt: new Date() },
          isNull(wallets.onchainActivatedAt),
        );
      }

      const walletId = wallet.id;
      wallet = yield* withScope(scope, (tx) =>
        Effect.gen(function* () {
          const [activated] = yield* query(() =>
            tx
              .update(wallets)
              .set({ status: "active" })
              .where(
                and(eq(wallets.id, walletId), eq(wallets.status, "creating")),
              )
              .returning(),
          );
          if (!activated) return yield* selectWallet(tx, organizationId);
          yield* audit.record(tx, {
            actor,
            organizationId,
            action: "wallet.created",
            entity: { type: "wallet", id: activated.id },
            after: {
              chain: activated.chain,
              address: activated.address,
              privyWalletId: activated.privyWalletId,
              transitAddress: activated.transitAddress,
              transitPrivyWalletId: activated.transitPrivyWalletId,
              privyPolicyId: activated.privyPolicyId,
              perTransactionMaxUsdc: activated.perTransactionMaxUsdc,
            },
          });
          return activated;
        }),
      );
    }

    // A wallet made before the move to NEAR has no transit wallet: its own
    // address is the one on Base.
    const baseAddress =
      wallet.chain === "base" ? wallet.address : wallet.transitAddress;
    if (wallet.depositsWatchedAt === null && baseAddress !== null) {
      yield* alchemy.watchAddresses([baseAddress]);
      wallet = yield* saveStep(
        wallet.id,
        { depositsWatchedAt: new Date() },
        isNull(wallets.depositsWatchedAt),
      );
    }

    return wallet;
  });
}
