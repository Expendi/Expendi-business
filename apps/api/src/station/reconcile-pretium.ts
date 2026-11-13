import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { PRETIUM_RECONCILE_JOB } from "../services/alerts/alert-checks.js";
import { recordHeartbeat } from "../services/alerts/ops-alerts.js";
import { reconcilePretiumPayouts } from "../services/payout/pretium-fund.js";

/**
 * Every minute, take each Pretium cash-out with USDC in flight one step on
 * and compare it with Pretium. Pretium's callbacks aren't guaranteed, so
 * this is what finishes every cash-out. Unlike Paycrest's job it can tell
 * Pretium about a sent transfer or ask for a refund, each at most once per
 * payout under its claim. Each finished run records a heartbeat, which the
 * "reconciliation stopped" alert watches, whether or not there was work.
 */
export const reconcilePretiumJob: StationJob = {
  name: PRETIUM_RECONCILE_JOB,
  everyMs: 60_000,
  lockKey: 72_053,
  run: reconcilePretiumPayouts().pipe(
    Effect.tap(() => recordHeartbeat(PRETIUM_RECONCILE_JOB)),
  ),
};
