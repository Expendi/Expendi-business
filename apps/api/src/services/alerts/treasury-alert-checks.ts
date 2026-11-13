import { and, eq, inArray, max, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { UNSETTLED_TREASURY_MOVE_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { OpsAlertDetail } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { AlertSignal, CheckResult } from "./ops-alerts.js";
import { treasuryMoves } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { SWEEP_DUST_USDC } from "../intents/sweep.js";
import { fromMicro } from "../paycrest/amounts.js";
import { earnTotals } from "../treasury/figures.js";
import { earnVaultId } from "../treasury/turn-on.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";

/**
 * The four Treasury alerts (docs/work/treasury/spec.md, section 5, "Expendi
 * team"), read fresh on every run like the others. None carries an address,
 * a hash or anything a salary could be read from: only the company, the
 * direction and USDC amounts of its own Treasury.
 */

const SYSTEM_SCOPE = {} as const;

/** A move that hasn't settled this long after it started needs someone. */
export const TREASURY_MOVE_STUCK_MINUTES = 30;
/**
 * Privy's `total_deposited` and `total_withdrawn` follow a move by 10 to 20
 * seconds, and a move's own records settle a little after its Earn call.
 * The position is only compared once nothing has settled for this long.
 */
export const TREASURY_POSITION_SETTLE_MINUTES = 5;
/** A partial fill is reported if it settled within this window. */
export const TREASURY_PARTIAL_FILL_WINDOW_HOURS = 24;

const company = (name: string): OpsAlertDetail => ({
  label: "Company",
  value: name,
});

const usdc = (units: bigint): string => `${fromMicro(units)} USDC`;

const DIRECTION_WORDS = {
  to_treasury: "to Treasury",
  to_wallet: "to the wallet",
} as const;

interface StuckMoveRow extends Record<string, unknown> {
  readonly move_id: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly direction: keyof typeof DIRECTION_WORDS;
  readonly status: "open" | "needs_review";
  readonly requested_usdc: string;
  readonly started_at: Date;
  readonly failure: string | null;
}

/**
 * Fires for every move to or from Treasury still open, or under review, 30
 * minutes after it started. `needs_review` counts until a person settles
 * it: the move stays in that status, so the alert does too.
 */
export function treasuryMoveStuckCheck(
  now: Date = new Date(),
): Effect.Effect<CheckResult, DatabaseError, DatabaseService> {
  const startedBefore = new Date(
    now.getTime() - TREASURY_MOVE_STUCK_MINUTES * 60_000,
  );
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx.execute<StuckMoveRow>(
        sql`SELECT * FROM ops_alert_treasury_moves(${startedBefore.toISOString()}::timestamptz)`,
      ),
    ),
  ).pipe(
    Effect.map(({ rows }) => ({
      kind: "treasury_move_stuck" as const,
      firing: rows.map((row): AlertSignal => ({
        kind: "treasury_move_stuck",
        subjectKey: row.move_id,
        organizationId: row.organization_id,
        title: `Move ${DIRECTION_WORDS[row.direction]} not settled at ${row.organization_name}`,
        details: [
          company(row.organization_name),
          { label: "Move", value: row.move_id },
          {
            label: "Status",
            value: row.status === "open" ? "open" : "needs review",
          },
          { label: "Amount", value: usdc(BigInt(row.requested_usdc)) },
          {
            label: "Started",
            value: new Date(row.started_at).toISOString(),
          },
          ...(row.failure ? [{ label: "Reason", value: row.failure }] : []),
          {
            label: "What to check",
            value:
              "Open the company's Treasury move for its quotes and Privy actions. The company can't start another move until this one settles.",
          },
        ],
      })),
      keep: [],
    })),
  );
}

interface PartialFillRow extends Record<string, unknown> {
  readonly move_id: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly asked_usdc: string;
  readonly delivered_usdc: string;
}

/**
 * Fires for each vault withdrawal that delivered less than was asked, for a
 * day after it settled: the move completed for the smaller amount and the
 * admins were told, but the vault may be short of liquidity.
 */
export function treasuryPartialFillCheck(
  now: Date = new Date(),
): Effect.Effect<CheckResult, DatabaseError, DatabaseService> {
  const since = new Date(
    now.getTime() - TREASURY_PARTIAL_FILL_WINDOW_HOURS * 3_600_000,
  );
  return withScope(SYSTEM_SCOPE, (tx) =>
    query(() =>
      tx.execute<PartialFillRow>(
        sql`SELECT * FROM ops_alert_treasury_partial_fills(${since.toISOString()}::timestamptz)`,
      ),
    ),
  ).pipe(
    Effect.map(({ rows }) => ({
      kind: "treasury_partial_fill" as const,
      firing: rows.map((row): AlertSignal => ({
        kind: "treasury_partial_fill",
        subjectKey: row.move_id,
        organizationId: row.organization_id,
        title: `Treasury withdrawal filled in part at ${row.organization_name}`,
        details: [
          company(row.organization_name),
          { label: "Move", value: row.move_id },
          { label: "Asked", value: usdc(BigInt(row.asked_usdc)) },
          { label: "Delivered", value: usdc(BigInt(row.delivered_usdc)) },
          {
            label: "What to check",
            value:
              "The vault filled less than was asked, so the rest is still in Treasury. The move completed for the smaller amount and the company's admins were told.",
          },
        ],
      })),
      keep: [],
    })),
  );
}

interface TreasuryCompanyRow extends Record<string, unknown> {
  readonly organization_id: string;
  readonly organization_name: string;
  readonly treasury_address: string;
  readonly treasury_privy_wallet_id: string;
}

interface CompanyRecords {
  readonly unsettled: readonly {
    readonly id: string;
    readonly direction: keyof typeof DIRECTION_WORDS;
    readonly status: string;
  }[];
  readonly deposited: bigint;
  readonly withdrawn: bigint;
  readonly withdrawalsAsked: bigint;
  /** When the latest move or Earn call settled. */
  readonly lastSettledAt: Date | null;
}

const recordsOf = (
  organizationId: string,
): Effect.Effect<CompanyRecords, DatabaseError, DatabaseService> =>
  withScope({ organizationId, role: "accountant" }, (tx) =>
    Effect.gen(function* () {
      const unsettled = yield* query(() =>
        tx
          .select({
            id: treasuryMoves.id,
            direction: treasuryMoves.direction,
            status: treasuryMoves.status,
          })
          .from(treasuryMoves)
          .where(
            and(
              eq(treasuryMoves.organizationId, organizationId),
              inArray(treasuryMoves.status, [
                ...UNSETTLED_TREASURY_MOVE_STATUSES,
              ]),
            ),
          ),
      );
      const [settled] = yield* query(() =>
        tx
          .select({ at: max(treasuryMoves.settledAt) })
          .from(treasuryMoves)
          .where(eq(treasuryMoves.organizationId, organizationId)),
      );
      const totals = yield* earnTotals(tx, organizationId);
      const times = [settled?.at ?? null, totals.lastSettledAt].flatMap(
        (time) => (time === null ? [] : [new Date(time).getTime()]),
      );
      return {
        unsettled,
        deposited: totals.deposited,
        withdrawn: totals.withdrawn,
        withdrawalsAsked: totals.withdrawalsAsked,
        lastSettledAt: times.length === 0 ? null : new Date(Math.max(...times)),
      };
    }),
  );

/**
 * Per company with Treasury on: USDC sitting in its Treasury wallet with no
 * move open, and its position at Privy not matching Expendi's records.
 * One read of each per company serves both. A company whose chain or Privy
 * read fails keeps whatever alert it had for that check.
 *
 * Idle USDC: the Treasury wallet holds more than dust and no move is `open`.
 * (A move to Treasury has USDC in the wallet until the vault takes it, and
 * a move to the wallet until it is sent back, so that is not idle.) A move
 * in `needs_review` is named as the likely reason, because stranded USDC of
 * a stuck move lands exactly here.
 *
 * Mismatch: the position's `total_deposited` and `total_withdrawn` against
 * the Earn calls Expendi recorded as succeeded. Compared are those totals
 * and not `assets_in_vault`, which grows with yield. They count Earn calls
 * only and trail a call by 10 to 20 seconds, so nothing is compared while a
 * move is unsettled, or until 5 minutes after the last move or call
 * settled; the alert stays as it is inside that window. A withdrawal the
 * vault filled in part matches either what it delivered or what was asked,
 * since Privy doesn't say which its total counts.
 */
export function treasuryHoldingChecks(
  now: Date = new Date(),
): Effect.Effect<
  readonly CheckResult[],
  DatabaseError,
  DatabaseService | PrivyWallets | BaseRpc
> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope(SYSTEM_SCOPE, (tx) =>
      query(() =>
        tx.execute<TreasuryCompanyRow>(sql`SELECT * FROM treasury_companies()`),
      ),
    );
    const vault = yield* earnVaultId;
    const privy = yield* PrivyWallets;
    const idle: AlertSignal[] = [];
    const mismatch: AlertSignal[] = [];
    const keepIdle: string[] = [];
    const keepMismatch: string[] = [];
    const settledBefore =
      now.getTime() - TREASURY_POSITION_SETTLE_MINUTES * 60_000;

    for (const row of rows) {
      const id = row.organization_id;
      if (Option.isNone(vault)) {
        keepIdle.push(id);
        keepMismatch.push(id);
        continue;
      }
      const exit = yield* Effect.exit(
        Effect.all({
          records: recordsOf(id),
          held: baseUsdcBalance(row.treasury_address).pipe(Effect.either),
          position: privy
            .vaultPosition({
              privyWalletId: row.treasury_privy_wallet_id,
              vaultId: vault.value,
            })
            .pipe(Effect.either),
        }),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[alerts] Treasury of company ${id} unreadable`,
          Cause.pretty(exit.cause),
        );
        keepIdle.push(id);
        keepMismatch.push(id);
        continue;
      }
      const { records, held, position } = exit.value;

      if (held._tag === "Left") {
        keepIdle.push(id);
      } else if (
        held.right > SWEEP_DUST_USDC &&
        !records.unsettled.some((move) => move.status === "open")
      ) {
        const review = records.unsettled.find(
          (move) => move.status === "needs_review",
        );
        idle.push({
          kind: "treasury_usdc_idle",
          subjectKey: id,
          organizationId: id,
          title: `USDC idle in the Treasury wallet at ${row.organization_name}`,
          details: [
            company(row.organization_name),
            { label: "In the Treasury wallet", value: usdc(held.right) },
            ...(review
              ? [
                  {
                    label: "Likely reason",
                    value: `A move ${DIRECTION_WORDS[review.direction]} (${review.id}) is in needs review.`,
                  },
                ]
              : []),
            {
              label: "What to check",
              value: review
                ? "Look at that move first: its USDC is probably what is stranded. Nothing moves until a person settles it."
                : "No move is open, so nobody is moving this USDC. It may be a stranger's transfer or a move that ended without sending everything back. The company can't spend it.",
            },
          ],
        });
      }

      if (position._tag === "Left") {
        keepMismatch.push(id);
        continue;
      }
      const settling =
        records.unsettled.length > 0 ||
        (records.lastSettledAt !== null &&
          records.lastSettledAt.getTime() > settledBefore);
      if (settling) {
        keepMismatch.push(id);
        continue;
      }
      const { totalDeposited, totalWithdrawn } = position.right;
      const depositsMatch = totalDeposited === records.deposited;
      const withdrawalsMatch =
        totalWithdrawn === records.withdrawn ||
        totalWithdrawn === records.withdrawalsAsked;
      if (depositsMatch && withdrawalsMatch) continue;
      mismatch.push({
        kind: "treasury_position_mismatch",
        subjectKey: id,
        organizationId: id,
        title: `Treasury position doesn't match its moves at ${row.organization_name}`,
        details: [
          company(row.organization_name),
          {
            label: "Deposited",
            value: `Privy ${usdc(totalDeposited)}, Expendi's records ${usdc(records.deposited)}`,
          },
          {
            label: "Withdrawn",
            value: `Privy ${usdc(totalWithdrawn)}, Expendi's records ${usdc(records.withdrawn)}`,
          },
          {
            label: "What to check",
            value:
              "No move is open and the last one settled over 5 minutes ago, so this isn't Privy catching up. Compare the company's Earn actions with Privy's activity for its Treasury wallet.",
          },
        ],
      });
    }
    return [
      { kind: "treasury_usdc_idle", firing: idle, keep: keepIdle },
      {
        kind: "treasury_position_mismatch",
        firing: mismatch,
        keep: keepMismatch,
      },
    ] as const;
  });
}
