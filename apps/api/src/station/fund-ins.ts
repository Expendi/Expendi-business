import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { refreshOpenFundIns } from "../services/intents/fund-in.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, ask 1Click about each open fund-in and settle the ones
 * that finished. It only updates the fund-in's record: the ledger credit is
 * the deposit watcher's, when the USDC arrives.
 */
export const fundInsJob: StationJob = {
  name: "fund-ins",
  everyMs: 30_000,
  lockKey: 72_051,
  run: refreshOpenFundIns().pipe(
    Effect.map((run) => (run.settled + run.unanswered === 0 ? IDLE : run)),
  ),
};
