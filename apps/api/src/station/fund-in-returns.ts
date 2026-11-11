import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { returnFundIns } from "../services/intents/fund-in-return.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, return what a refunded fund-in left in a company's NEAR
 * Intents account to its company wallet, and move on the returns already
 * open. The deposit watcher credits each one when it arrives.
 */
export const fundInReturnsJob: StationJob = {
  name: "fund-in-returns",
  everyMs: 30_000,
  lockKey: 72_052,
  run: returnFundIns().pipe(
    Effect.map((summary) =>
      summary.advanced + summary.started + summary.errors === 0
        ? IDLE
        : summary,
    ),
  ),
};
