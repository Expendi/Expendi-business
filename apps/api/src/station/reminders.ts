import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { runSpendingReminders } from "../services/notification/reminders.js";
import { IDLE } from "./scheduler.js";

/**
 * Sends each day's bill reminders and wallet-short warning (spec §6.10)
 * from 8:00 Nairobi time. Checked every 15 minutes so a restart or a bill
 * added later in the day still gets its reminder; each one goes out once.
 */
export const spendingRemindersJob: StationJob = {
  name: "spending-reminders",
  everyMs: 15 * 60_000,
  lockKey: 72_043,
  run: runSpendingReminders().pipe(
    Effect.map((run) =>
      run === null ||
      (run.bills === 0 && run.walletWarnings === 0 && run.failed === 0)
        ? IDLE
        : run,
    ),
  ),
};
