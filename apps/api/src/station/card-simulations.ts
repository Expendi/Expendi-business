import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { runDueCardSimulations } from "../services/card-simulations/daily.js";
import { IDLE } from "./scheduler.js";

/**
 * Sandbox only (spec §6.25): the pretend merchant's Card purchase for each
 * card-paid bill on its due date, until real merchants charge real cards.
 * Checked every 15 minutes like the other daily jobs, so a bill due today
 * is charged early in the Nairobi day and a restart misses nothing; the
 * service's own rules keep it to one purchase a bill a day.
 */
export const cardSimulationsJob: StationJob = {
  name: "card-simulations",
  everyMs: 15 * 60_000,
  lockKey: 72_058,
  run: runDueCardSimulations().pipe(
    Effect.map((run) =>
      run === null ||
      run.approved + run.declined + run.unknown + run.failed === 0
        ? IDLE
        : run,
    ),
  ),
};
