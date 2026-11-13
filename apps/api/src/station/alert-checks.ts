import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { runAlerts } from "../services/alerts/run-alerts.js";
import { IDLE } from "./scheduler.js";

/**
 * Every minute, check the alerts and email the alert list about each
 * new incident, once (spec §6.16).
 */
export const alertChecksJob: StationJob = {
  name: "alert-checks",
  everyMs: 60_000,
  lockKey: 72_026,
  run: runAlerts().pipe(
    Effect.map((run) =>
      run.opened + run.resolved + run.notified + run.emailFailures === 0 &&
      run.failedChecks === 0
        ? IDLE
        : run,
    ),
  ),
};
