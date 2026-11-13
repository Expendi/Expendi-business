import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Effect, Option } from "effect";

import type {
  TreasuryMoveDirection,
  TreasuryMoveList,
  TreasuryMovePreview,
  TreasuryMoveSummary,
} from "@expendi-business/shared";
import {
  MIN_TREASURY_MOVE_USDC,
  UNSETTLED_TREASURY_MOVE_STATUSES,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { TreasuryMove, Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
  ConfirmationPurpose,
} from "../approval/passkeys.js";
import type { OneClick } from "../intents/one-click.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import { treasuryMoves, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  Forbidden,
  ServiceUnavailable,
} from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  estimateTreasuryPart,
  estimateTreasuryReturnPart,
} from "../intents/treasury-quote.js";
import { isPaused } from "../payout/guards.js";
import { availableUsdc } from "../wallet/ledger.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { earnVaultId } from "./turn-on.js";

/**
 * Starting and previewing a move between the company wallet and Treasury
 * (docs/work/treasury/spec.md, sections 4 and 5). Starting only saves the
 * move with its approval: the station job (`advanceTreasuryMove`) moves the
 * money.
 */

const SECONDS_PER_PART_OUTSIDE_THE_QUOTE = 30;
/** The vault's withdrawal before the first part can be sent back. */
const WITHDRAWAL_SECONDS = 30;

const adminsOnly = new Forbidden({
  message: "Only an admin of this company can move money to or from Treasury.",
});
const notWhatWasConfirmed = new Forbidden({
  message: "That isn't what you confirmed. Confirm again.",
});
const notAvailable = new ServiceUnavailable({
  message: "Treasury isn't available yet.",
});
const notTurnedOn = new Conflict({
  message: "Turn on Treasury before moving money to it.",
});
const alreadyOpen = new Conflict({
  message:
    "A move to or from Treasury is already open. Wait for it to finish before starting another.",
});
const pausedConflict = new Conflict({
  message: "Payouts are paused, so Treasury moves can't start. Nothing moved.",
});
const tooSmall = new BadRequest({
  message: "The least you can move is 10 USDC.",
});
const allOnlyToWallet = new BadRequest({
  message: 'Only a move to your wallet can be "all".',
});
const nothingInTreasury = new Conflict({
  message: "Treasury holds nothing to move.",
});
const positionUnreadable = new ServiceUnavailable({
  message: "Treasury's value can't be read right now. Nothing moved.",
});

export type TreasuryMoveError =
  Forbidden | BadRequest | Conflict | ServiceUnavailable | DatabaseError;

export interface TreasuryMoveRequestInput {
  readonly direction: TreasuryMoveDirection;
  /** USDC base units, or `"all"` for everything the vault holds (to the wallet only). */
  readonly amountUsdc: bigint | "all";
}

/** What the passkey signs: this company, the direction and the amount. */
export function treasuryMoveIntentHash(
  organizationId: string,
  request: TreasuryMoveRequestInput,
): string {
  return sha256Hex(
    canonicalJson({
      version: 1,
      kind: "treasury_move",
      organizationId,
      direction: request.direction,
      amountUsdc: request.amountUsdc,
    }),
  );
}

const purposeOf = (direction: TreasuryMoveDirection): ConfirmationPurpose =>
  direction === "to_treasury" ? "move_to_treasury" : "move_to_wallet";

const requireAdmin = (tenant: Tenant) =>
  tenant.role === "admin" ? Effect.void : Effect.fail(adminsOnly);

const requireVault = Effect.flatMap(earnVaultId, (vault) =>
  Option.isSome(vault) ? Effect.void : Effect.fail(notAvailable),
);

/** Parts of `amount`, each within the wallet's per-transaction cap. */
export function partsOf(amount: bigint, cap: bigint): number {
  return Number((amount + cap - 1n) / cap);
}

/** What a request comes to once the vault's value is known. */
interface ResolvedMove {
  readonly direction: TreasuryMoveDirection;
  readonly amount: bigint;
  readonly isAll: boolean;
  /** To the wallet only: what Treasury was worth when it was read. */
  readonly inTreasury: bigint | null;
}

/**
 * Turns a request into an amount. A move to the wallet reads what Treasury
 * is worth now from Privy and refuses more than that; "all" is that value.
 * Read before a passkey is spent, so a refusal doesn't cost a confirmation.
 */
function resolveRequest(
  tenant: Tenant,
  request: TreasuryMoveRequestInput,
): Effect.Effect<
  ResolvedMove,
  BadRequest | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | PrivyWallets
> {
  return Effect.gen(function* () {
    if (request.direction === "to_treasury") {
      if (request.amountUsdc === "all")
        return yield* Effect.fail(allOnlyToWallet);
      return {
        direction: request.direction,
        amount: request.amountUsdc,
        isAll: false,
        inTreasury: null,
      };
    }
    const [wallet] = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select()
          .from(wallets)
          .where(
            and(
              eq(wallets.organizationId, tenant.organizationId),
              eq(wallets.status, "active"),
            ),
          ),
      ),
    );
    if (wallet?.treasuryTurnedOnAt == null || !wallet.treasuryPrivyWalletId) {
      return yield* Effect.fail(notTurnedOn);
    }
    const vault = yield* earnVaultId;
    if (Option.isNone(vault)) return yield* Effect.fail(notAvailable);
    const privy = yield* PrivyWallets;
    const position = yield* privy
      .vaultPosition({
        privyWalletId: wallet.treasuryPrivyWalletId,
        vaultId: vault.value,
      })
      .pipe(Effect.mapError(() => positionUnreadable));
    const worth = position.assetsInVault;
    if (request.amountUsdc === "all") {
      if (worth <= 0n) return yield* Effect.fail(nothingInTreasury);
      return {
        direction: request.direction,
        amount: worth,
        isAll: true,
        inTreasury: worth,
      };
    }
    if (request.amountUsdc > worth) {
      return yield* Effect.fail(
        new Conflict({
          message: "Treasury doesn't hold that much. Nothing moved.",
          details: { inTreasuryUsdc: worth.toString() },
        }),
      );
    }
    return {
      direction: request.direction,
      amount: request.amountUsdc,
      isAll: false,
      inTreasury: worth,
    };
  });
}

/**
 * Everything that must hold before a move starts, read in `tx`. With `lock`
 * it takes the company wallet's row lock first, as payout approval does, so a
 * payout and a move started together queue and the second sees what the first
 * reserved. Only a move to Treasury needs the company wallet to have the
 * USDC: a move to the wallet takes it from the vault.
 */
function checkMove(
  tx: Transaction,
  organizationId: string,
  move: ResolvedMove,
  lock: boolean,
): Effect.Effect<
  { readonly wallet: Wallet; readonly available: bigint },
  Conflict | BadRequest | DatabaseError
> {
  return Effect.gen(function* () {
    const select = tx
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.organizationId, organizationId),
          eq(wallets.status, "active"),
        ),
      );
    const [wallet] = yield* query(() => (lock ? select.for("update") : select));
    if (wallet?.treasuryTurnedOnAt == null) {
      return yield* Effect.fail(notTurnedOn);
    }
    if (yield* isPaused(tx, organizationId)) {
      return yield* Effect.fail(pausedConflict);
    }
    if (move.amount < MIN_TREASURY_MOVE_USDC && !move.isAll) {
      return yield* Effect.fail(tooSmall);
    }
    const [open] = yield* query(() =>
      tx
        .select({ id: treasuryMoves.id })
        .from(treasuryMoves)
        .where(
          and(
            eq(treasuryMoves.organizationId, organizationId),
            inArray(treasuryMoves.status, [
              ...UNSETTLED_TREASURY_MOVE_STATUSES,
            ]),
          ),
        )
        .limit(1),
    );
    if (open) return yield* Effect.fail(alreadyOpen);
    const available = yield* availableUsdc(tx, wallet.id);
    if (move.direction === "to_treasury" && available < move.amount) {
      const shortfall = move.amount - available;
      return yield* Effect.fail(
        new Conflict({
          message:
            "The company wallet doesn't have that much available to move. Nothing moved.",
          details: {
            availableUsdc: (available > 0n ? available : 0n).toString(),
            shortfallUsdc: shortfall.toString(),
          },
        }),
      );
    }
    return { wallet, available };
  });
}

/**
 * What a move would cost and take: the parts it splits into and a dry 1Click
 * quote for one of them. No money moves and nothing is saved.
 */
export function previewTreasuryMove(
  tenant: Tenant,
  request: TreasuryMoveRequestInput,
): Effect.Effect<
  TreasuryMovePreview,
  TreasuryMoveError,
  DatabaseService | OneClick | PrivyWallets
> {
  return Effect.gen(function* () {
    yield* requireAdmin(tenant);
    yield* requireVault;
    const resolved = yield* resolveRequest(tenant, request);
    const { wallet, available } = yield* withScope(tenant, (tx) =>
      checkMove(tx, tenant.organizationId, resolved, false),
    );
    const cap = wallet.perTransactionMaxUsdc;
    const parts = partsOf(resolved.amount, cap);
    const largestPart = (resolved.amount + BigInt(parts) - 1n) / BigInt(parts);
    const estimateOne =
      resolved.direction === "to_treasury"
        ? estimateTreasuryPart
        : estimateTreasuryReturnPart;
    const estimate = yield* estimateOne({
      organizationId: tenant.organizationId,
      amountIn: largestPart,
    }).pipe(
      Effect.catchTag("QuoteNotOpened", (error) =>
        Effect.fail(
          new ServiceUnavailable({
            message: `Treasury couldn't price this move right now: ${error.message}`,
          }),
        ),
      ),
    );
    return {
      direction: resolved.direction,
      amountUsdc: resolved.amount.toString(),
      ...(resolved.isAll && { isAll: true }),
      parts,
      perPartMaxUsdc: cap.toString(),
      estimatedCostUsdc: (estimate.costUsdc * BigInt(parts)).toString(),
      estimatedSeconds:
        parts * (estimate.seconds + SECONDS_PER_PART_OUTSIDE_THE_QUOTE) +
        (resolved.direction === "to_wallet" ? WITHDRAWAL_SECONDS : 0),
      availableUsdc: (available > 0n ? available : 0n).toString(),
      ...(resolved.inTreasury !== null && {
        inTreasuryUsdc: resolved.inTreasury.toString(),
      }),
    };
  });
}

/** Asks for the admin's passkey for exactly this direction and amount. */
export function startMoveConfirmation(
  tenant: Tenant,
  request: TreasuryMoveRequestInput,
): Effect.Effect<
  ApprovalChallenge,
  TreasuryMoveError,
  DatabaseService | AuditLog | ApprovalSettings | PrivyWallets
> {
  return Effect.gen(function* () {
    yield* requireAdmin(tenant);
    yield* requireVault;
    const resolved = yield* resolveRequest(tenant, request);
    yield* withScope(tenant, (tx) =>
      checkMove(tx, tenant.organizationId, resolved, false),
    );
    return yield* startApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: purposeOf(request.direction),
      intentHash: treasuryMoveIntentHash(tenant.organizationId, request),
    });
  });
}

/**
 * Starts a move once the admin's passkey has confirmed exactly this
 * direction and amount (or "all"). Under the company wallet's row lock it
 * checks Treasury is on, payouts aren't paused, the amount is at least 10
 * USDC (unless "all"), nothing else is open and, to Treasury, the wallet has
 * that much available, then saves the move open. To the wallet the most is
 * what Treasury is worth now, read live before the passkey is spent. The
 * reservation of a move to Treasury holds from that commit on.
 */
export function startTreasuryMove(
  tenant: Tenant,
  input: TreasuryMoveRequestInput & {
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
  },
): Effect.Effect<
  TreasuryMove,
  TreasuryMoveError,
  DatabaseService | AuditLog | ApprovalSettings | PrivyWallets
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* requireAdmin(tenant);
    yield* requireVault;
    const resolved = yield* resolveRequest(tenant, input);
    const approval = yield* verifyApproval({
      organizationId,
      userId: tenant.userId,
      purpose: purposeOf(input.direction),
      challengeId: input.challengeId,
      response: input.response,
    });
    if (treasuryMoveIntentHash(organizationId, input) !== approval.intentHash) {
      return yield* Effect.fail(notWhatWasConfirmed);
    }
    const audit = yield* AuditLog;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const { wallet } = yield* checkMove(tx, organizationId, resolved, true);
        const [move] = yield* query(() =>
          tx
            .insert(treasuryMoves)
            .values({
              organizationId,
              walletId: wallet.id,
              direction: input.direction,
              requestedUsdc: resolved.amount,
              isAll: resolved.isAll,
              confirmedBy: tenant.userId,
              approvalId: approval.approvalId,
            })
            .returning(),
        );
        if (!move)
          return yield* Effect.dieMessage("move insert returned no row");
        yield* audit.record(tx, {
          actor: { type: "user", id: tenant.userId },
          organizationId,
          action: "treasury_move.started",
          entity: { type: "treasury_move", id: move.id },
          after: {
            direction: move.direction,
            requestedUsdc: move.requestedUsdc,
            ...(move.isAll && { isAll: true }),
            approvalId: approval.approvalId,
            parts: partsOf(move.requestedUsdc, wallet.perTransactionMaxUsdc),
          },
        });
        return move;
      }),
    ).pipe(
      // The wallet lock already queues two starts; the partial unique index
      // is what still holds if something ever reaches the insert without it.
      Effect.catchTag(
        "DatabaseError",
        (error): Effect.Effect<never, Conflict | DatabaseError> =>
          violatedUniqueConstraint(error.cause) ===
          "treasury_moves_one_unsettled_per_company"
            ? Effect.fail(alreadyOpen)
            : Effect.fail(error),
      ),
    );
  });
}

const iso = (date: Date): string => date.toISOString();

/** A move as the API shows it. */
export function toMoveSummary(move: TreasuryMove): TreasuryMoveSummary {
  return {
    id: move.id,
    direction: move.direction,
    status: move.status,
    requestedUsdc: move.requestedUsdc.toString(),
    movedUsdc: move.movedUsdc?.toString() ?? null,
    costUsdc: move.costUsdc?.toString() ?? null,
    failure: move.failure,
    createdAt: iso(move.createdAt),
    settledAt: move.settledAt ? iso(move.settledAt) : null,
  };
}

/** The company's moves, newest first, for admins and accountants. */
export function listTreasuryMoves(
  tenant: Tenant,
  limit = 100,
): Effect.Effect<TreasuryMoveList, DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select()
        .from(treasuryMoves)
        .where(eq(treasuryMoves.organizationId, tenant.organizationId))
        .orderBy(desc(treasuryMoves.createdAt), desc(treasuryMoves.id))
        .limit(limit),
    ),
  ).pipe(Effect.map((rows) => ({ moves: rows.map(toMoveSummary) })));
}
