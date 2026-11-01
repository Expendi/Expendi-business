import type { ConfigError } from "effect";
import { and, eq, isNull } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AlchemyNotifyError } from "../alchemy/alchemy-webhook.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { PrivyWalletError, PrivyWalletRecord } from "./privy-wallets.js";
import { wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AlchemyWebhook } from "../alchemy/alchemy-webhook.js";
import { AuditLog } from "../audit/audit-log.js";
import { PrivyWallets } from "./privy-wallets.js";

const USDC_PER_WHOLE_DOLLAR = 1_000_000n;

export interface WalletSettingsShape {
  /** Owns every company wallet and policy; its private key is never in the API. */
  readonly managementQuorumId: string;
  /** The API's signer on every company wallet. */
  readonly runtimeSignerId: string;
  /** Written into each new wallet's policy, in USDC base units. */
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
  PrivyWalletError | AlchemyNotifyError | WalletMisconfigured | DatabaseError;

export type EnsureCompanyWalletDeps =
  DatabaseService | AuditLog | PrivyWallets | AlchemyWebhook | WalletSettings;

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

function checkPrivyWallet(
  record: PrivyWalletRecord,
  expected: {
    readonly policyId: string;
    readonly managementQuorumId: string;
    readonly runtimeSignerId: string;
  },
): Effect.Effect<PrivyWalletRecord, WalletMisconfigured> {
  const problems = [
    record.ownerId !== expected.managementQuorumId &&
      `owner is ${record.ownerId ?? "none"}`,
    (record.policyIds.length !== 1 ||
      record.policyIds[0] !== expected.policyId) &&
      `policies are [${record.policyIds.join(", ")}]`,
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
 * Gives a company its one wallet (spec §6.9, §7.1), safe to call any number
 * of times, concurrently or after a crash. Each step is keyed so a retry
 * resumes rather than repeats:
 *
 * 1. the `wallets` row, unique per company;
 * 2. the Privy policy, created with an idempotency key from the row ID, and
 *    its ID saved;
 * 3. the Privy wallet, found by its external ID (the company ID) if an
 *    earlier attempt created it, otherwise created with an idempotency key,
 *    then checked for the expected owner, policy and signer;
 * 4. activation, audited in the same transaction;
 * 5. the Alchemy webhook told to watch the address, so deposits show up.
 */
export function ensureCompanyWallet(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
}): Effect.Effect<Wallet, EnsureCompanyWalletError, EnsureCompanyWalletDeps> {
  const { organizationId, actor } = input;
  const scope = { organizationId };

  return Effect.gen(function* () {
    const settings = yield* WalletSettings;
    const privy = yield* PrivyWallets;
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
      let policyId = wallet.privyPolicyId;
      if (!policyId) {
        const created = yield* privy.createPolicy({
          name: `company-${organizationId}`,
          perTransactionMaxUsdc: wallet.perTransactionMaxUsdc,
          ownerQuorumId: settings.managementQuorumId,
          idempotencyKey: `wallet-policy-${wallet.id}`,
        });
        wallet = yield* withScope(scope, (tx) =>
          query(() =>
            tx
              .update(wallets)
              .set({ privyPolicyId: created.policyId })
              .where(
                and(eq(wallets.id, wallet.id), isNull(wallets.privyPolicyId)),
              ),
          ).pipe(Effect.zipRight(selectWallet(tx, organizationId))),
        );
        policyId = wallet.privyPolicyId ?? created.policyId;
      }

      const existing = yield* privy.findWalletByExternalId(organizationId);
      const privyWallet = yield* checkPrivyWallet(
        existing ??
          (yield* privy.createWallet({
            externalId: organizationId,
            displayName: `company-${organizationId}`,
            policyId,
            ownerQuorumId: settings.managementQuorumId,
            signerQuorumId: settings.runtimeSignerId,
            idempotencyKey: `wallet-${wallet.id}`,
          })),
        { ...settings, policyId },
      );

      wallet = yield* withScope(scope, (tx) =>
        Effect.gen(function* () {
          const [activated] = yield* query(() =>
            tx
              .update(wallets)
              .set({
                status: "active",
                privyWalletId: privyWallet.id,
                address: privyWallet.address,
              })
              .where(
                and(eq(wallets.id, wallet.id), eq(wallets.status, "creating")),
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
              privyPolicyId: activated.privyPolicyId,
              perTransactionMaxUsdc: activated.perTransactionMaxUsdc,
            },
          });
          return activated;
        }),
      );
    }

    if (wallet.depositsWatchedAt === null && wallet.address !== null) {
      yield* alchemy.watchAddresses([wallet.address]);
      wallet = yield* withScope(scope, (tx) =>
        query(() =>
          tx
            .update(wallets)
            .set({ depositsWatchedAt: new Date() })
            .where(eq(wallets.id, wallet.id))
            .returning(),
        ).pipe(
          Effect.flatMap(([watched]) =>
            watched
              ? Effect.succeed(watched)
              : selectWallet(tx, organizationId),
          ),
        ),
      );
    }

    return wallet;
  });
}
