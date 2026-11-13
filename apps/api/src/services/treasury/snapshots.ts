import { sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import { treasurySnapshots } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { earnVaultId } from "./turn-on.js";

/**
 * The day's Treasury snapshot (docs/work/treasury/spec.md, sections 8 and
 * 10): for every company with Treasury on, Privy's position and the vault's
 * rate, once per Africa/Nairobi day.
 *
 * The day is the Nairobi date when the run starts and `read_at` is that
 * moment or later, so a row for a day was always read at or after 00:00 of
 * it. The job runs every 15 minutes: the first run after midnight writes the
 * day's row and the runs after it find the company already done and ask
 * Privy for nothing. The unique (company, day) key is what holds if two runs
 * overlap.
 */

export interface SnapshotRun {
  readonly day: string;
  readonly written: number;
  /** Companies Privy couldn't be read for; the next run tries again. */
  readonly failed: number;
}

export function writeTreasurySnapshots(
  now: Date = new Date(),
): Effect.Effect<SnapshotRun, DatabaseError, DatabaseService | PrivyWallets> {
  const day = nairobiDate(now);
  return Effect.gen(function* () {
    const vault = yield* earnVaultId;
    if (Option.isNone(vault)) return { day, written: 0, failed: 0 };
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<{
          organization_id: string;
          treasury_privy_wallet_id: string;
        }>(sql`SELECT * FROM treasury_snapshot_companies(${day}::date)`),
      ),
    );
    if (rows.length === 0) return { day, written: 0, failed: 0 };
    const privy = yield* PrivyWallets;
    const rate = yield* privy.vaultDetails(vault.value).pipe(Effect.option);
    let written = 0;
    let failed = 0;
    for (const row of rows) {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const position = yield* privy.vaultPosition({
            privyWalletId: row.treasury_privy_wallet_id,
            vaultId: vault.value,
          });
          const inserted = yield* withScope(
            { organizationId: row.organization_id },
            (tx) =>
              query(() =>
                tx
                  .insert(treasurySnapshots)
                  .values({
                    organizationId: row.organization_id,
                    snapshotDate: day,
                    assetsInVault: position.assetsInVault,
                    sharesInVault: position.sharesInVault,
                    userApy: Option.getOrNull(rate)?.userApyBps ?? null,
                    readAt: now,
                  })
                  .onConflictDoNothing()
                  .returning({ id: treasurySnapshots.id }),
              ),
          );
          return inserted.length;
        }),
      );
      if (Exit.isFailure(exit)) {
        failed += 1;
        console.error(
          `[treasury-snapshots] company ${row.organization_id} not read`,
          Cause.pretty(exit.cause),
        );
        continue;
      }
      written += exit.value;
    }
    return { day, written, failed };
  });
}
