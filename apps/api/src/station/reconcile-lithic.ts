import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { reconcileCardPurchases } from "../services/cards/reconcile.js";
import { IDLE } from "./scheduler.js";

/**
 * Every minute, compare unfinished Card purchases with Lithic (spec §6.25).
 * Only reads Lithic and updates our records, so it's always safe to run.
 */
export const reconcileLithicJob: StationJob = {
  name: "reconcile-lithic",
  everyMs: 60_000,
  lockKey: 72_045,
  run: reconcileCardPurchases().pipe(
    Effect.map((summary) => (summary.checked === 0 ? IDLE : summary)),
  ),
};
