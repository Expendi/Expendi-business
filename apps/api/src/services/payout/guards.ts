import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import {
  organizations,
  payouts,
  platformSettings,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/** The payout, locked for the rest of the transaction. */
export function lockPayout(
  tx: Transaction,
  payoutId: string,
): Effect.Effect<Payout | null, DatabaseError> {
  return query(() =>
    tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update"),
  ).pipe(Effect.map(([payout]) => payout ?? null));
}

/** Whether the company's or the platform's payouts are paused. */
export function isPaused(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<boolean, DatabaseError> {
  return Effect.gen(function* () {
    const [company] = yield* query(() =>
      tx
        .select({ paused: organizations.payoutsPaused })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    );
    const [platform] = yield* query(() =>
      tx
        .select({ paused: platformSettings.payoutsPaused })
        .from(platformSettings)
        .limit(1),
    );
    return !company || company.paused || (platform?.paused ?? true);
  });
}
