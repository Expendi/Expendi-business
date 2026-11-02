import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { RECONCILE_JOB } from "../services/alerts/alert-checks.js";
import { recordHeartbeat } from "../services/alerts/ops-alerts.js";
import { reconcilePaycrestPayouts } from "../services/payout/sync.js";

/**
 * Every minute, compare unfinished payouts with Paycrest (spec §6.8). It
 * only reads Paycrest and updates our records: it never creates an order or
 * sends money, so it is always safe to run. Each finished run records a
 * heartbeat, which the "reconciliation stopped" alert watches (spec §6.16).
 */
export const reconcilePaycrestJob: StationJob = {
  name: RECONCILE_JOB,
  everyMs: 60_000,
  lockKey: 72_001,
  run: reconcilePaycrestPayouts().pipe(
    Effect.tap(() => recordHeartbeat(RECONCILE_JOB)),
  ),
};
