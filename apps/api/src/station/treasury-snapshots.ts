import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { writeTreasurySnapshots } from "../services/treasury/snapshots.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 15 minutes, write today's (Africa/Nairobi) Treasury snapshot for each
 * company with Treasury on that doesn't have one yet. Safe to run twice: a
 * company with a snapshot for the day isn't read again.
 */
export const treasurySnapshotsJob: StationJob = {
  name: "treasury-snapshots",
  everyMs: 15 * 60_000,
  lockKey: 72_054,
  run: Effect.suspend(() => writeTreasurySnapshots()).pipe(
    Effect.map((run) => (run.written + run.failed === 0 ? IDLE : run)),
  ),
};
