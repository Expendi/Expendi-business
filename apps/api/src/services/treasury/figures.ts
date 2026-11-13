import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type {
  TreasuryMoveDirection,
  TreasuryOpenMove,
  TreasuryStatus,
} from "@expendi-business/shared";
import { UNSETTLED_TREASURY_MOVE_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Wallet } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import {
  treasuryEarnActions,
  treasuryMoves,
  treasurySnapshots,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { activeKesRateOrNull } from "../cash-out/active-rate.js";
import { kesCentsFor } from "../paycrest/amounts.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { earnVaultId } from "./turn-on.js";

/**
 * What the Treasury account shows (docs/work/treasury/spec.md, section 5,
 * "What the admin sees"): what it is worth, what it has earned, the rate and
 * the move in progress.
 *
 * Value and rate are Privy's, read now. If Privy can't be reached the last
 * snapshot answers instead, with the time it was read, so the screen never
 * fails on an outage. A snapshot is at most a day old (the
 * `treasury-snapshots` job writes one per Nairobi day) and the screen says
 * when it was read.
 */

/** What a Treasury wallet's vault calls moved in and out, from Expendi's own records. */
export interface EarnTotals {
  /** What the vault took: the `raw_amount` of every succeeded deposit. */
  readonly deposited: bigint;
  /**
   * What the vault gave back: what each succeeded withdrawal delivered
   * (`delivered_usdc`; a vault may fill in part), or what was asked while
   * that has not been read yet.
   */
  readonly withdrawn: bigint;
  /** What was asked of succeeded withdrawals, whatever they delivered. */
  readonly withdrawalsAsked: bigint;
  /** A call is saved or pending, so Privy and these records can disagree for a moment. */
  readonly callInFlight: boolean;
  /** When the latest call settled; null if none has. */
  readonly lastSettledAt: Date | null;
}

/**
 * Totals of the company's Earn calls, optionally only those settled by
 * `settledBy` (to match a snapshot read at that time).
 *
 * "Moved in" is what the vault took and "moved out" what it gave back, not
 * the company wallet's debits and credits: 1Click's costs and a refunded
 * part happen outside the vault and are no yield, so a vault that earned
 * nothing shows exactly zero.
 */
export function earnTotals(
  tx: Transaction,
  organizationId: string,
  settledBy?: Date,
): Effect.Effect<EarnTotals, DatabaseError> {
  const actions = treasuryEarnActions;
  return query(() =>
    tx
      .select({
        deposited: sql<string>`coalesce(sum(${actions.rawAmount}) filter (where ${actions.kind} = 'deposit' and ${actions.status} = 'succeeded'), 0)::text`,
        withdrawn: sql<string>`coalesce(sum(coalesce(${actions.deliveredUsdc}, ${actions.rawAmount})) filter (where ${actions.kind} = 'withdraw' and ${actions.status} = 'succeeded'), 0)::text`,
        withdrawalsAsked: sql<string>`coalesce(sum(${actions.rawAmount}) filter (where ${actions.kind} = 'withdraw' and ${actions.status} = 'succeeded'), 0)::text`,
        callInFlight: sql<boolean>`coalesce(bool_or(${actions.status} in ('saved', 'pending')), false)`,
        lastSettledAt: sql<Date | null>`max(${actions.settledAt})`,
      })
      .from(actions)
      .where(
        and(
          eq(actions.organizationId, organizationId),
          settledBy === undefined
            ? undefined
            : lte(actions.settledAt, settledBy),
        ),
      ),
  ).pipe(
    Effect.map(([row]) => ({
      deposited: BigInt(row?.deposited ?? "0"),
      withdrawn: BigInt(row?.withdrawn ?? "0"),
      withdrawalsAsked: BigInt(row?.withdrawalsAsked ?? "0"),
      callInFlight: row?.callInFlight ?? false,
      lastSettledAt: row?.lastSettledAt ? new Date(row.lastSettledAt) : null,
    })),
  );
}

const STATUS_TEXT: Record<
  "open" | "needs_review",
  Record<TreasuryMoveDirection, string>
> = {
  open: {
    to_treasury: "On its way to Treasury",
    to_wallet: "On its way to your wallet",
  },
  needs_review: {
    to_treasury: "Being checked by Expendi",
    to_wallet: "Being checked by Expendi",
  },
};

/** The company's unsettled move, if it has one, as the account shows it. */
export function openMoveOf(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<TreasuryOpenMove | null, DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(treasuryMoves)
      .where(
        and(
          eq(treasuryMoves.organizationId, organizationId),
          inArray(treasuryMoves.status, [...UNSETTLED_TREASURY_MOVE_STATUSES]),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map(([move]) => {
      if (!move) return null;
      const status = move.status === "needs_review" ? "needs_review" : "open";
      return {
        id: move.id,
        direction: move.direction,
        amountUsdc: move.requestedUsdc.toString(),
        isAll: move.isAll,
        status,
        statusText: STATUS_TEXT[status][move.direction],
        startedAt: move.createdAt.toISOString(),
      };
    }),
  );
}

const lastSnapshot = (tx: Transaction, organizationId: string) =>
  query(() =>
    tx
      .select()
      .from(treasurySnapshots)
      .where(eq(treasurySnapshots.organizationId, organizationId))
      .orderBy(desc(treasurySnapshots.readAt))
      .limit(1),
  ).pipe(Effect.map(([snapshot]) => snapshot ?? null));

/**
 * `GET /organizations/:id/treasury` for a company with Treasury on. Reads
 * Privy's position and the vault's rate together; either failing is not an
 * error: the position falls back to the last snapshot (and its time) and the
 * rate to the snapshot's, and with nothing saved the figures are null.
 *
 * Yield is value, less everything the vault took, plus everything it gave
 * back (`earnTotals`). From a snapshot it uses only the calls settled by the
 * time the snapshot was read, so a move made since doesn't skew it. While a
 * call is in flight it is null: the live value can already include a
 * deposit the records don't yet.
 */
export function treasuryOnStatus(
  tenant: Tenant,
  wallet: Wallet,
): Effect.Effect<
  TreasuryStatus,
  DatabaseError,
  DatabaseService | PrivyWallets | Paycrest | Pretium
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const { treasuryAddress, treasuryPrivyWalletId } = wallet;
    if (!treasuryAddress || !treasuryPrivyWalletId) {
      return yield* Effect.dieMessage("Treasury is on without a wallet");
    }
    const vault = yield* earnVaultId;
    const privy = yield* PrivyWallets;
    const [position, details] = Option.isNone(vault)
      ? [null, null]
      : yield* Effect.all(
          [
            privy
              .vaultPosition({
                privyWalletId: treasuryPrivyWalletId,
                vaultId: vault.value,
              })
              .pipe(Effect.option),
            privy.vaultDetails(vault.value).pipe(Effect.option),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(
            ([read, rate]) =>
              [Option.getOrNull(read), Option.getOrNull(rate)] as const,
          ),
        );
    const readAt = new Date();
    const { snapshot, openMove, totals } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const snapshot = yield* lastSnapshot(tx, organizationId);
        const openMove = yield* openMoveOf(tx, organizationId);
        const useSnapshot = position === null && snapshot !== null;
        const totals = yield* earnTotals(
          tx,
          organizationId,
          useSnapshot ? snapshot.readAt : undefined,
        );
        return { snapshot, openMove, totals };
      }),
    );

    const value = position?.assetsInVault ?? snapshot?.assetsInVault ?? null;
    const asOf = position ? readAt : (snapshot?.readAt ?? null);
    const rateBps = details?.userApyBps ?? snapshot?.userApy ?? null;
    const yieldUsdc =
      value === null || (position !== null && totals.callInFlight)
        ? null
        : value - totals.deposited + totals.withdrawn;

    const rate = value === null ? null : yield* activeKesRateOrNull("treasury");
    return {
      status: "on",
      address: treasuryAddress,
      valueUsdc: value?.toString() ?? null,
      yieldUsdc: yieldUsdc?.toString() ?? null,
      rateBps,
      kesEquivalent:
        value === null || rate === null
          ? null
          : {
              kesCents: kesCentsFor(value > 0n ? value : 0n, rate).toString(),
              rate,
            },
      openMove,
      asOf: asOf?.toISOString() ?? null,
      saved: position === null,
    };
  });
}

/**
 * `GET /organizations/:id/treasury`: unavailable without a vault, off until
 * turned on, then the figures.
 */
export function getTreasuryStatus(
  tenant: Tenant,
): Effect.Effect<
  TreasuryStatus,
  DatabaseError,
  DatabaseService | PrivyWallets | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const vault = yield* earnVaultId;
    if (Option.isNone(vault)) return { status: "unavailable" };
    const wallet = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select()
          .from(wallets)
          .where(eq(wallets.organizationId, tenant.organizationId))
          .limit(1),
      ),
    ).pipe(Effect.map(([row]) => row ?? null));
    if (wallet?.treasuryTurnedOnAt)
      return yield* treasuryOnStatus(tenant, wallet);
    const privy = yield* PrivyWallets;
    // The invitation to turn Treasury on carries the rate, but a Privy outage
    // must never fail the status.
    const details = yield* privy
      .vaultDetails(vault.value)
      .pipe(Effect.option, Effect.map(Option.getOrNull));
    return { status: "off", rateBps: details?.userApyBps ?? null };
  });
}
