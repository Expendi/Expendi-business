import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { moveIn } from "../services/intents/move-in.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, move the USDC waiting in the company wallet of each
 * company that keeps its balance in a confidential account into that
 * account, and move on the move-ins already open.
 */
export const moveInsJob: StationJob = {
  name: "move-ins",
  everyMs: 30_000,
  lockKey: 72_055,
  run: moveIn().pipe(
    Effect.map((summary) =>
      summary.advanced + summary.started + summary.errors === 0
        ? IDLE
        : summary,
    ),
  ),
};
