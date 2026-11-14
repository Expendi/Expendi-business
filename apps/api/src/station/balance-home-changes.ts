import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { advanceBalanceHomeChanges } from "../services/intents/confidential-rollout.js";
import { IDLE } from "./scheduler.js";

export const balanceHomeChangesJob: StationJob = {
  name: "balance-home-changes",
  everyMs: 30_000,
  lockKey: 72_062,
  run: advanceBalanceHomeChanges().pipe(
    Effect.map((result) =>
      result.draining + result.errors + result.enabled + result.waiting === 0
        ? IDLE
        : result,
    ),
  ),
};
