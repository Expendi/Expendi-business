import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { deliverMonthlyExports } from "../services/export/monthly.js";
import { IDLE } from "./scheduler.js";

/**
 * Emails each company's accountants last month's export (spec §6.11). It's
 * due once Nairobi's 1st begins, and checked every 15 minutes so it goes
 * out soon after midnight, and still goes out after downtime. A pass with
 * nothing to make or send changes nothing.
 */
export const monthlyExportJob: StationJob = {
  name: "monthly-export",
  everyMs: 15 * 60_000,
  lockKey: 72_022,
  run: Effect.suspend(() => deliverMonthlyExports(new Date())).pipe(
    Effect.map((run) =>
      run.created === 0 && run.emailed === 0 && run.failed === 0 ? IDLE : run,
    ),
  ),
};
