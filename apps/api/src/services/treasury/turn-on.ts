import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { SQL } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";
import { Cause, Config, Effect, Option } from "effect";

import type { TreasuryStatus } from "@expendi-business/shared";
import { MAIN_CHAIN } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { NewWallet, Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
} from "../approval/passkeys.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { WalletMisconfigured } from "../wallet/company-wallet.js";
import type { PrivyWalletError } from "../wallet/privy-wallets.js";
import { organizations, users, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, Forbidden, ServiceUnavailable } from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { EmailSender } from "../email/email-sender.js";
import { treasuryTurnedOnEmail } from "../email/treasury-email.js";
import { activeAdminRecipients } from "../payees/payees.js";
import { checkPrivyWallet, WalletSettings } from "../wallet/company-wallet.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";

/**
 * Privy's ID for the one Earn vault every Treasury uses (not the contract
 * address). None while unset: Treasury is then unavailable.
 */
export const earnVaultId: Effect.Effect<Option.Option<string>> = Config.option(
  Config.nonEmptyString("PRIVY_EARN_VAULT_ID"),
).pipe(Effect.orDie);

/** The Treasury wallet's external ID in Privy. */
export const treasuryExternalId = (organizationId: string): string =>
  `treasury-${organizationId}`;

const unavailable = new ServiceUnavailable({
  message: "Treasury isn't available yet.",
});
const adminsOnly = new Forbidden({
  message: "Only an admin of this company can turn on Treasury.",
});
const notWhatWasConfirmed = new Forbidden({
  message: "That isn't what you confirmed. Confirm again.",
});
const walletNotReady = new Conflict({
  message:
    "Treasury needs the company wallet to be set up on NEAR first. Try again in a moment.",
});

export type TurnOnTreasuryError =
  | ServiceUnavailable
  | Conflict
  | PrivyWalletError
  | WalletMisconfigured
  | DatabaseError;

export type TurnOnTreasuryDeps =
  DatabaseService | AuditLog | PrivyWallets | WalletSettings | EmailSender;

/** What the passkey signs: this company and the one action. */
export function turnOnTreasuryIntentHash(organizationId: string): string {
  return sha256Hex(
    canonicalJson({
      version: 1,
      kind: "turn_on_treasury",
      organizationId,
    }),
  );
}

const readWallet = (tx: Transaction, organizationId: string) =>
  query(() =>
    tx
      .select()
      .from(wallets)
      .where(eq(wallets.organizationId, organizationId))
      .limit(1),
  ).pipe(Effect.map(([wallet]) => wallet ?? null));

/** The company wallet Treasury hangs off: on NEAR and ready to use. */
const requireReadyWallet = (wallet: Wallet | null) =>
  wallet !== null && wallet.chain === MAIN_CHAIN && wallet.status === "active"
    ? Effect.succeed(wallet)
    : Effect.fail(walletNotReady);

export function getTreasuryStatus(
  tenant: Tenant,
): Effect.Effect<TreasuryStatus, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const vault = yield* earnVaultId;
    if (Option.isNone(vault)) return { status: "unavailable" };
    const wallet = yield* withScope(tenant, (tx) =>
      readWallet(tx, tenant.organizationId),
    );
    return wallet?.treasuryTurnedOnAt && wallet.treasuryAddress
      ? { status: "on", address: wallet.treasuryAddress }
      : { status: "off" };
  });
}

const saved = <A>(value: A | null, what: string): Effect.Effect<A> =>
  value === null
    ? Effect.dieMessage(`Treasury has no ${what} after it was saved`)
    : Effect.succeed(value);

/**
 * Gives a company its Treasury wallet on Base (docs/decisions/treasury-on-base.md,
 * spec §5, §7) and turns Treasury on. Safe to call any number of times,
 * concurrently or after a crash: each step saves what it made before the
 * next begins and is keyed, so a retry resumes rather than repeats, and
 * once on, calling it again changes nothing.
 *
 * 1. the Treasury policy, created with an idempotency key;
 * 2. the Treasury wallet, found by its external ID or created the same way,
 *    then checked for the expected owner, policy and signer;
 * 3. `treasuryTurnedOnAt`, audited in the same transaction, then every
 *    admin emailed (best effort, after the commit).
 *
 * Nothing moves: this only creates the wallet.
 */
export function turnOnTreasury(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
  /** The passkey confirmation that authorised it, for the audit entry. */
  readonly approvalId?: string;
}): Effect.Effect<Wallet, TurnOnTreasuryError, TurnOnTreasuryDeps> {
  const { organizationId, actor } = input;
  const scope = { organizationId };

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
      ).pipe(
        Effect.zipRight(readWallet(tx, organizationId)),
        Effect.flatMap((row) =>
          row ? Effect.succeed(row) : Effect.dieMessage("wallet row vanished"),
        ),
      ),
    );

  return Effect.gen(function* () {
    const vault = yield* earnVaultId;
    if (Option.isNone(vault)) return yield* Effect.fail(unavailable);
    const vaultId = vault.value;
    const settings = yield* WalletSettings;
    const privy = yield* PrivyWallets;
    const audit = yield* AuditLog;

    let wallet = yield* withScope(scope, (tx) =>
      readWallet(tx, organizationId),
    ).pipe(Effect.flatMap(requireReadyWallet));
    if (wallet.treasuryTurnedOnAt !== null) return wallet;

    if (wallet.treasuryPrivyPolicyId === null) {
      const created = yield* privy.createTreasuryPolicy({
        name: treasuryExternalId(organizationId),
        vaultId,
        perTransactionMaxUsdc: wallet.perTransactionMaxUsdc,
        ownerQuorumId: settings.managementQuorumId,
        idempotencyKey: `treasury-policy-${wallet.id}`,
      });
      wallet = yield* saveStep(
        wallet.id,
        { treasuryPrivyPolicyId: created.policyId },
        isNull(wallets.treasuryPrivyPolicyId),
      );
    }
    const policyId = yield* saved(wallet.treasuryPrivyPolicyId, "policy");

    if (wallet.treasuryPrivyWalletId === null) {
      const externalId = treasuryExternalId(organizationId);
      const existing = yield* privy.findWalletByExternalId(externalId);
      const treasuryWallet = yield* checkPrivyWallet(
        existing ??
          (yield* privy.createWallet({
            externalId,
            displayName: externalId,
            policyId,
            ownerQuorumId: settings.managementQuorumId,
            signerQuorumId: settings.runtimeSignerId,
            idempotencyKey: `treasury-wallet-${wallet.id}`,
          })),
        { ...settings, policyId },
      );
      wallet = yield* saveStep(
        wallet.id,
        {
          treasuryPrivyWalletId: treasuryWallet.id,
          treasuryAddress: treasuryWallet.address,
        },
        isNull(wallets.treasuryPrivyWalletId),
      );
    }

    const walletId = wallet.id;
    const turnedOn = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const [updated] = yield* query(() =>
          tx
            .update(wallets)
            .set({
              treasuryTurnedOnAt: new Date(),
              treasuryTurnedOnBy: actor.id,
            })
            .where(
              and(eq(wallets.id, walletId), isNull(wallets.treasuryTurnedOnAt)),
            )
            .returning(),
        );
        if (!updated) {
          const current = yield* readWallet(tx, organizationId);
          return { wallet: current ?? wallet, notice: null };
        }
        yield* audit.record(tx, {
          actor,
          organizationId,
          action: "treasury.turned_on",
          entity: { type: "wallet", id: updated.id },
          after: {
            treasuryAddress: updated.treasuryAddress,
            treasuryPrivyWalletId: updated.treasuryPrivyWalletId,
            treasuryPrivyPolicyId: updated.treasuryPrivyPolicyId,
            vaultId,
            ...(input.approvalId && { approvalId: input.approvalId }),
          },
        });
        return {
          wallet: updated,
          notice: yield* turnedOnNotice(tx, organizationId, actor.id),
        };
      }),
    );
    if (turnedOn.notice) yield* sendNotice(turnedOn.notice);
    return turnedOn.wallet;
  });
}

interface TurnedOnNotice {
  readonly recipients: readonly {
    readonly userId: string;
    readonly email: string;
  }[];
  readonly companyName: string;
  readonly actorName: string;
}

function turnedOnNotice(
  tx: Transaction,
  organizationId: string,
  actorId: string,
): Effect.Effect<TurnedOnNotice, DatabaseError> {
  return Effect.gen(function* () {
    const recipients = yield* activeAdminRecipients(tx, organizationId);
    const [company] = yield* query(() =>
      tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    );
    const [person] = yield* query(() =>
      tx
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, actorId)),
    );
    return {
      recipients,
      companyName: company?.name ?? "your company",
      actorName: person?.fullName ?? person?.email ?? "An admin",
    };
  });
}

/**
 * Best effort, after the commit: a failed email never undoes turning
 * Treasury on and is logged with the admin's user ID only.
 */
function sendNotice(
  notice: TurnedOnNotice,
): Effect.Effect<void, never, EmailSender> {
  return Effect.forEach(
    notice.recipients,
    ({ userId, email }) =>
      Effect.flatMap(EmailSender, (sender) =>
        sender.send(treasuryTurnedOnEmail({ ...notice, to: email })),
      ).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            console.error(
              `[treasury] turned-on email to admin ${userId} not sent`,
              Cause.pretty(cause),
            );
          }),
        ),
      ),
    { discard: true },
  );
}

const requireAdmin = (tenant: Tenant) =>
  tenant.role === "admin" ? Effect.void : Effect.fail(adminsOnly);

/** Asks for the admin's passkey; nothing is created until it's confirmed. */
export function startTurnOnTreasuryConfirmation(
  tenant: Tenant,
): Effect.Effect<
  ApprovalChallenge,
  Forbidden | ServiceUnavailable | Conflict | DatabaseError,
  DatabaseService | AuditLog | ApprovalSettings
> {
  return Effect.gen(function* () {
    yield* requireAdmin(tenant);
    if (Option.isNone(yield* earnVaultId))
      return yield* Effect.fail(unavailable);
    yield* withScope(tenant, (tx) =>
      readWallet(tx, tenant.organizationId),
    ).pipe(Effect.flatMap(requireReadyWallet));
    return yield* startApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: "turn_on_treasury",
      intentHash: turnOnTreasuryIntentHash(tenant.organizationId),
    });
  });
}

/** Turns Treasury on once the admin's passkey has confirmed exactly that. */
export function confirmTurnOnTreasury(
  tenant: Tenant,
  input: {
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
  },
): Effect.Effect<
  TreasuryStatus,
  Forbidden | TurnOnTreasuryError,
  TurnOnTreasuryDeps | ApprovalSettings
> {
  return Effect.gen(function* () {
    yield* requireAdmin(tenant);
    const approval = yield* verifyApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: "turn_on_treasury",
      challengeId: input.challengeId,
      response: input.response,
    });
    if (
      turnOnTreasuryIntentHash(tenant.organizationId) !== approval.intentHash
    ) {
      return yield* Effect.fail(notWhatWasConfirmed);
    }
    const wallet = yield* turnOnTreasury({
      organizationId: tenant.organizationId,
      actor: { type: "user", id: tenant.userId },
      approvalId: approval.approvalId,
    });
    return yield* Effect.map(
      saved(wallet.treasuryAddress, "address"),
      (address) => ({
        status: "on" as const,
        address,
      }),
    );
  });
}
