import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { syncDueAccounting } from "../services/zoho/sync.js";
import { IDLE } from "./scheduler.js";

/**
 * Every minute, push paid spending that's due to Zoho Books (spec §6.17).
 * Each run takes a small batch, so a backlog after reconnecting drains over
 * a few minutes inside Zoho's per-organization rate limit.
 */
export const zohoSyncJob: StationJob = {
  name: "zoho-sync",
  everyMs: 60_000,
  lockKey: 72_031,
  run: syncDueAccounting().pipe(
    Effect.map((summary) => (summary.considered === 0 ? IDLE : summary)),
  ),
};
