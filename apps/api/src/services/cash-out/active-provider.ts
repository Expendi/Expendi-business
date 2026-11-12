import { Effect } from "effect";

import type { CashOutProvider } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { platformSettings } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * The cash-out provider new cash-outs go through, as staff last set it for
 * every company. Read in the caller's transaction, as `isPaused` reads the
 * pause.
 */
export function activeCashOutProvider(
  tx: Transaction,
): Effect.Effect<CashOutProvider, DatabaseError> {
  return query(() =>
    tx
      .select({ provider: platformSettings.activeCashOutProvider })
      .from(platformSettings)
      .limit(1),
  ).pipe(
    // A missing row already pauses every payout, so no money moves either way.
    Effect.map(([settings]) => settings?.provider ?? "paycrest"),
  );
}
