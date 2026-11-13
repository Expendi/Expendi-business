import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Cause, Data, Effect, Option, Redacted } from "effect";

import type {
  OpsAlertKind,
  TreasuryMoveDirection,
  TreasuryMoveList,
  TreasuryMovePreview,
  TreasuryMoveSummary,
  TreasuryStatus,
} from "@expendi-business/shared";
import { TREASURY_MOVE_DIRECTIONS } from "@expendi-business/shared";

import type { IntentQuote } from "../../src/db/schema/index.js";
import type { DatabaseError } from "../../src/errors.js";
import type { AppDeps } from "../../src/layers/main.js";
import type { Tenant } from "../../src/middleware/tenant.js";
import type { StrandedReturn } from "../../src/services/treasury/stranded.js";
import type { BalanceReconciliation } from "../../src/services/wallet/reconcile.js";
import { ConfigService } from "../../src/config.js";
import { DatabaseService } from "../../src/db/client.js";
import {
  companyWalletSends,
  intentQuotes,
  memberships,
  opsAlerts,
  organizations,
  treasuryEarnActions,
  treasuryMoves,
  users,
  wallets,
  walletTransactions,
} from "../../src/db/schema/index.js";
import { query, withScope } from "../../src/db/scope.js";
import { isClientError } from "../../src/errors.js";
import {
  ApprovalSettings,
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../src/services/approval/passkeys.js";
import { getTreasuryStatus } from "../../src/services/treasury/figures.js";
import {
  listTreasuryMoves,
  previewTreasuryMove,
  startMoveConfirmation,
  startTreasuryMove,
  toMoveSummary,
} from "../../src/services/treasury/moves.js";
import { returnStrandedDeposit } from "../../src/services/treasury/stranded.js";
import {
  confirmTurnOnTreasury,
  earnVaultId,
  startTurnOnTreasuryConfirmation,
} from "../../src/services/treasury/turn-on.js";
import { PrivyWallets } from "../../src/services/wallet/privy-wallets.js";
import { reconcileBalances } from "../../src/services/wallet/reconcile.js";
import { SoftwarePasskey } from "./software-passkey.js";

/**
 * What `scripts/treasury-qa.ts` does, one Effect program per command, so a
 * test can drive them. Each returns data; `treasury-qa-format.ts` turns it
 * into text. They call the services the Treasury routes call, with a
 * `Tenant` built the way the tenant middleware builds one, and they never
 * step a move: the station job does that, so the driver can't race it.
 */

/** A mistake in how the script was run, not a failure of the system. */
export class QaUsageError extends Data.TaggedError("QaUsageError")<{
  readonly message: string;
}> {}

const usage = (message: string) => Effect.fail(new QaUsageError({ message }));

const ACTOR = { type: "system", id: "treasury-qa-script" } as const;
const MICRO = 1_000_000n;

/**
 * "12.5" is 12_500_000n. Whole numbers and up to six decimals, nothing
 * else, and more than zero; null otherwise.
 */
export function parseUsdc(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  const units =
    BigInt(match[1]) * MICRO + BigInt((match[2] ?? "").padEnd(6, "0"));
  return units === 0n ? null : units;
}

/** 12_500_000n is "12.500000". */
export function formatUsdc(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  return `${sign}${(abs / MICRO).toString()}.${(abs % MICRO).toString().padStart(6, "0")}`;
}

export interface MoveArguments {
  readonly direction: string | undefined;
  readonly usdc: string | undefined;
  readonly all: boolean;
}

export interface MoveRequest {
  readonly direction: TreasuryMoveDirection;
  readonly amountUsdc: bigint | "all";
}

export function parseMoveRequest(
  input: MoveArguments,
): Effect.Effect<MoveRequest, QaUsageError> {
  return Effect.gen(function* () {
    const direction = TREASURY_MOVE_DIRECTIONS.find(
      (candidate) => candidate === input.direction,
    );
    if (!direction) {
      return yield* usage(
        `Pass --direction ${TREASURY_MOVE_DIRECTIONS.join(" or ")}`,
      );
    }
    if (input.all === (input.usdc !== undefined)) {
      return yield* usage("Pass either --usdc <amount> or --all");
    }
    if (input.usdc === undefined) return { direction, amountUsdc: "all" };
    const units = parseUsdc(input.usdc);
    if (units === null) {
      return yield* usage(
        `Not a USDC amount: "${input.usdc}". Use a number above zero with at most 6 decimals, like 12.5`,
      );
    }
    return { direction, amountUsdc: units };
  });
}

/** Where a QA admin's software passkey lives between runs. */
export interface PasskeyStore {
  readonly save: (userId: string, key: SoftwarePasskey) => Promise<void>;
  readonly load: (userId: string) => Promise<SoftwarePasskey | null>;
}

/** Owner-only files in an owner-only directory, git-ignored under `.cache/`. */
export function filePasskeyStore(directory: URL): PasskeyStore {
  const file = (userId: string) => new URL(`passkey-${userId}.json`, directory);
  return {
    async save(userId, key) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(file(userId), JSON.stringify(key.toJSON()), {
        mode: 0o600,
      });
      await chmod(file(userId), 0o600);
    },
    async load(userId) {
      try {
        const raw = await readFile(file(userId), "utf8");
        return SoftwarePasskey.restore(
          JSON.parse(raw) as ReturnType<SoftwarePasskey["toJSON"]>,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

export interface QaOptions {
  readonly organizationId: string;
  readonly adminEmail?: string | undefined;
  readonly passkeys: PasskeyStore;
}

/** What every command prints first, so a person can see where they are. */
export interface QaBanner {
  readonly companyName: string;
  /** `host:port` of the database, never its credentials. */
  readonly databaseHost: string;
}

export const banner = (
  organizationId: string,
): Effect.Effect<
  QaBanner,
  QaUsageError | DatabaseError,
  DatabaseService | ConfigService
> =>
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const [organization] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, organizationId)),
      ),
    );
    if (!organization) {
      return yield* usage(`No company with ID ${organizationId}`);
    }
    return {
      companyName: organization.name,
      databaseHost: new URL(Redacted.value(config.databaseUrl)).host,
    };
  });

const userIdOf = (email: string) =>
  Effect.gen(function* () {
    const { db } = yield* DatabaseService;
    const [user] = yield* query(() =>
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase())),
    );
    return user?.id ?? (yield* usage(`No user with email ${email}`));
  });

/**
 * The tenant the middleware would build for this person: their active
 * membership in the company. Without an email, a company admin stands in,
 * for the commands that only read.
 */
function tenantFor(
  options: QaOptions,
  needsEmail: boolean,
): Effect.Effect<Tenant, QaUsageError | DatabaseError, DatabaseService> {
  const { organizationId, adminEmail } = options;
  return Effect.gen(function* () {
    if (adminEmail === undefined && needsEmail) {
      return yield* usage("Pass --admin-email");
    }
    const userId =
      adminEmail === undefined ? undefined : yield* userIdOf(adminEmail);
    const [membership] = yield* withScope(
      userId === undefined ? { organizationId } : { userId },
      (tx) =>
        query(() =>
          tx
            .select({
              id: memberships.id,
              role: memberships.role,
              userId: memberships.userId,
            })
            .from(memberships)
            .where(
              and(
                eq(memberships.organizationId, organizationId),
                eq(memberships.status, "active"),
                userId === undefined
                  ? eq(memberships.role, "admin")
                  : eq(memberships.userId, userId),
              ),
            )
            .orderBy(asc(memberships.createdAt))
            .limit(1),
        ),
    );
    if (!membership) {
      return yield* usage(
        adminEmail === undefined
          ? "The company has no active admin"
          : `${adminEmail} isn't an active member of this company`,
      );
    }
    return {
      organizationId,
      userId: membership.userId,
      membershipId: membership.id,
      role: membership.role,
    };
  });
}

/** Signs a passkey challenge as the admin and keeps the key's new counter. */
function signChallenge(
  options: QaOptions,
  userId: string,
  challenge: PublicKeyCredentialRequestOptionsJSON,
): Effect.Effect<AuthenticationResponseJSON, QaUsageError, ApprovalSettings> {
  return Effect.gen(function* () {
    const settings = yield* ApprovalSettings;
    const key = yield* Effect.promise(() => options.passkeys.load(userId));
    if (key === null) {
      return yield* usage(
        "No QA passkey for this admin on this machine. Run enrol first",
      );
    }
    const response = key.sign(challenge, settings.origins[0] ?? "");
    yield* Effect.promise(() => options.passkeys.save(userId, key));
    return response;
  });
}

export const enrol = (options: QaOptions) =>
  Effect.gen(function* () {
    if (options.adminEmail === undefined) {
      return yield* usage("Pass --admin-email");
    }
    const userId = yield* userIdOf(options.adminEmail);
    const settings = yield* ApprovalSettings;
    const key = SoftwarePasskey.create();
    const registration = yield* startPasskeyEnrolment(userId);
    yield* finishPasskeyEnrolment(
      userId,
      key.register(registration, settings.origins[0] ?? ""),
    );
    yield* Effect.promise(() => options.passkeys.save(userId, key));
    return {
      userId,
      email: options.adminEmail,
      credentialId: key.credentialId,
    };
  });

export const status = (
  options: QaOptions,
): Effect.Effect<TreasuryStatus, unknown, AppDeps> =>
  Effect.flatMap(tenantFor(options, false), getTreasuryStatus);

export const turnOn = (
  options: QaOptions,
): Effect.Effect<TreasuryStatus, unknown, AppDeps> =>
  Effect.gen(function* () {
    const tenant = yield* tenantFor(options, true);
    const challenge = yield* startTurnOnTreasuryConfirmation(tenant);
    const response = yield* signChallenge(
      options,
      tenant.userId,
      challenge.options,
    );
    yield* confirmTurnOnTreasury(tenant, {
      challengeId: challenge.challengeId,
      response,
    });
    return yield* getTreasuryStatus(tenant);
  });

export const preview = (
  options: QaOptions,
  request: MoveRequest,
): Effect.Effect<TreasuryMovePreview, unknown, AppDeps> =>
  Effect.flatMap(tenantFor(options, false), (tenant) =>
    previewTreasuryMove(tenant, request),
  );

export const startMove = (
  options: QaOptions,
  request: MoveRequest,
  confirmed: boolean,
): Effect.Effect<TreasuryMoveSummary, unknown, AppDeps> =>
  Effect.gen(function* () {
    if (!confirmed) {
      return yield* usage(
        "This moves real money. Run it again with --yes to go ahead",
      );
    }
    const tenant = yield* tenantFor(options, true);
    const challenge = yield* startMoveConfirmation(tenant, request);
    const response = yield* signChallenge(
      options,
      tenant.userId,
      challenge.options,
    );
    const move = yield* startTreasuryMove(tenant, {
      ...request,
      challengeId: challenge.challengeId,
      response,
    });
    return toMoveSummary(move);
  });

export const moves = (
  options: QaOptions,
): Effect.Effect<TreasuryMoveList, unknown, AppDeps> =>
  Effect.flatMap(tenantFor(options, false), (tenant) =>
    listTreasuryMoves(tenant),
  );

export interface VaultReading {
  readonly assetsInVault: bigint;
  readonly sharesInVault: bigint;
  readonly totalDeposited: bigint;
  readonly totalWithdrawn: bigint;
}

export interface MoveInspection {
  readonly move: TreasuryMoveSummary & { readonly walletId: string };
  readonly quotes: readonly {
    readonly id: string;
    readonly purpose: IntentQuote["purpose"];
    readonly status: IntentQuote["status"];
    readonly amountIn: bigint;
    readonly amountOut: bigint;
    readonly swappedAmountOut: bigint | null;
    readonly depositAddress: string;
    readonly oneClickStatus: IntentQuote["oneClickStatus"];
    readonly failure: string | null;
    /** NEAR transactions: the company wallet's send and what 1Click reports. */
    readonly nearTxHashes: readonly string[];
    /** Base transactions 1Click reports. */
    readonly baseTxHashes: readonly string[];
  }[];
  readonly earnActions: readonly {
    readonly id: string;
    readonly kind: "deposit" | "withdraw";
    readonly attempt: number;
    readonly referenceId: string;
    readonly status: string;
    readonly rawAmount: bigint;
    readonly deliveredUsdc: bigint | null;
    readonly privyActionId: string | null;
    readonly txHash: string | null;
    readonly failure: string | null;
  }[];
  readonly ledger: readonly {
    readonly type: string;
    readonly usdcAmount: bigint;
    readonly txHash: string | null;
    readonly createdAt: Date;
  }[];
  /** Null when Treasury is off, has no vault, or Privy can't be read. */
  readonly vault: VaultReading | null;
  readonly vaultNote: string | null;
}

/**
 * Where each transaction of a quote happened. A move to Treasury starts on
 * NEAR (the company wallet's send, then 1Click's own) and ends on Base; a
 * move to the wallet is the reverse.
 */
function hashesByChain(
  quote: IntentQuote,
  sendTxHash: string | null,
): { near: string[]; base: string[] } {
  const toTreasury = quote.purpose === "to_treasury";
  const origin = quote.originChainTxHashes;
  const destination = quote.destinationChainTxHashes;
  const deposit = quote.depositTxHash ? [quote.depositTxHash] : [];
  return {
    near: [
      ...(sendTxHash ? [sendTxHash] : []),
      ...(toTreasury ? [...deposit, ...origin] : destination),
      ...quote.nearTxHashes,
    ],
    base: toTreasury ? destination : [...deposit, ...origin],
  };
}

export const inspect = (
  options: QaOptions,
  moveId: string,
): Effect.Effect<MoveInspection, unknown, AppDeps> =>
  Effect.gen(function* () {
    const { organizationId } = options;
    const found = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [move] = yield* query(() =>
          tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, moveId)),
        );
        if (!move) return null;
        const quotes = yield* query(() =>
          tx
            .select()
            .from(intentQuotes)
            .where(eq(intentQuotes.treasuryMoveId, moveId))
            .orderBy(asc(intentQuotes.createdAt), asc(intentQuotes.id)),
        );
        const sendIds = quotes.flatMap((quote) =>
          quote.companyWalletSendId ? [quote.companyWalletSendId] : [],
        );
        const sends =
          sendIds.length === 0
            ? []
            : yield* query(() =>
                tx
                  .select({
                    id: companyWalletSends.id,
                    txHash: companyWalletSends.txHash,
                  })
                  .from(companyWalletSends)
                  .where(inArray(companyWalletSends.id, sendIds)),
              );
        const actions = yield* query(() =>
          tx
            .select()
            .from(treasuryEarnActions)
            .where(eq(treasuryEarnActions.treasuryMoveId, moveId))
            .orderBy(
              asc(treasuryEarnActions.createdAt),
              asc(treasuryEarnActions.attempt),
            ),
        );
        const ledger = yield* query(() =>
          tx
            .select({
              type: walletTransactions.type,
              usdcAmount: walletTransactions.usdcAmount,
              txHash: walletTransactions.txHash,
              createdAt: walletTransactions.createdAt,
            })
            .from(walletTransactions)
            .where(eq(walletTransactions.treasuryMoveId, moveId))
            .orderBy(asc(walletTransactions.createdAt)),
        );
        const [wallet] = yield* query(() =>
          tx.select().from(wallets).where(eq(wallets.id, move.walletId)),
        );
        return { move, quotes, sends, actions, ledger, wallet };
      }),
    );
    if (found === null)
      return yield* usage(`No move ${moveId} in this company`);
    const { move, quotes, sends, actions, ledger, wallet } = found;
    const sendHash = new Map(sends.map((send) => [send.id, send.txHash]));

    const vaultId = yield* earnVaultId;
    let vault: VaultReading | null = null;
    let vaultNote: string | null = null;
    if (!wallet?.treasuryPrivyWalletId) {
      vaultNote = "Treasury isn't turned on, so there is no vault position";
    } else if (Option.isNone(vaultId)) {
      vaultNote = "No Earn vault is configured";
    } else {
      const privy = yield* PrivyWallets;
      const reading = yield* privy
        .vaultPosition({
          privyWalletId: wallet.treasuryPrivyWalletId,
          vaultId: vaultId.value,
        })
        .pipe(Effect.either);
      if (reading._tag === "Right") {
        vault = reading.right;
      } else {
        vaultNote = `Privy couldn't be read: ${reading.left.message}`;
      }
    }

    return {
      move: { ...toMoveSummary(move), walletId: move.walletId },
      quotes: quotes.map((quote) => {
        const hashes = hashesByChain(
          quote,
          quote.companyWalletSendId
            ? (sendHash.get(quote.companyWalletSendId) ?? null)
            : null,
        );
        return {
          id: quote.id,
          purpose: quote.purpose,
          status: quote.status,
          amountIn: quote.amountIn,
          amountOut: quote.amountOut,
          swappedAmountOut: quote.swappedAmountOut,
          depositAddress: quote.depositAddress,
          oneClickStatus: quote.oneClickStatus,
          failure: quote.failure,
          nearTxHashes: [...new Set(hashes.near)],
          baseTxHashes: [...new Set(hashes.base)],
        };
      }),
      earnActions: actions.map((action) => ({
        id: action.id,
        kind: action.kind,
        attempt: action.attempt,
        referenceId: action.referenceId,
        status: action.status,
        rawAmount: action.rawAmount,
        deliveredUsdc: action.deliveredUsdc,
        privyActionId: action.privyActionId,
        txHash: action.txHash,
        failure: action.failure,
      })),
      ledger,
      vault,
      vaultNote,
    };
  });

export type Reconciliation = BalanceReconciliation;

export const reconcile = (
  options: QaOptions,
): Effect.Effect<Reconciliation, unknown, AppDeps> =>
  reconcileBalances(options.organizationId).pipe(
    Effect.flatMap((result) =>
      result === null
        ? usage("The company has no active company wallet")
        : Effect.succeed(result),
    ),
  );

export const TREASURY_ALERT_KINDS = [
  "treasury_move_stuck",
  "treasury_usdc_idle",
  "treasury_position_mismatch",
  "treasury_partial_fill",
] as const satisfies readonly OpsAlertKind[];

export interface OpenAlert {
  readonly kind: OpsAlertKind;
  readonly subjectKey: string;
  readonly title: string;
  readonly occurrences: number;
  readonly openedAt: Date;
  readonly details: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export const alerts = (
  options: QaOptions,
): Effect.Effect<readonly OpenAlert[], unknown, AppDeps> =>
  // Ops alerts are the team's own record: only work outside any company or
  // user context can read them, so the company is a filter, not a scope.
  withScope({}, (tx) =>
    query(() =>
      tx
        .select({
          kind: opsAlerts.kind,
          subjectKey: opsAlerts.subjectKey,
          title: opsAlerts.title,
          occurrences: opsAlerts.occurrences,
          openedAt: opsAlerts.openedAt,
          details: opsAlerts.details,
        })
        .from(opsAlerts)
        .where(
          and(
            eq(opsAlerts.organizationId, options.organizationId),
            isNull(opsAlerts.resolvedAt),
            inArray(opsAlerts.kind, [...TREASURY_ALERT_KINDS]),
          ),
        )
        .orderBy(asc(opsAlerts.openedAt)),
    ),
  );

export const returnStranded = (
  options: QaOptions,
  moveId: string,
  confirmed: boolean,
): Effect.Effect<StrandedReturn, unknown, AppDeps> =>
  Effect.gen(function* () {
    if (!confirmed) {
      return yield* usage(
        "This sends the move's undeposited USDC back. Run it again with --yes to go ahead",
      );
    }
    return yield* returnStrandedDeposit({
      organizationId: options.organizationId,
      moveId,
      actor: ACTOR,
    });
  });

/** One line for a failure: the service's own message for an expected refusal. */
export function describeFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof QaUsageError) return error.message;
    if (isClientError(error)) {
      const details =
        "details" in error && error.details
          ? ` (${JSON.stringify(error.details)})`
          : "";
      return `Refused: ${error.message}${details}`;
    }
  }
  return `Failed unexpectedly: ${Cause.pretty(cause)}`;
}
