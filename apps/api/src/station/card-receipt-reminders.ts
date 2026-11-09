import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { runCardReceiptReminders } from "../services/cards/reminders.js";
import { IDLE } from "./scheduler.js";

/**
 * Daily reminders for Card purchases still missing a receipt, from 8:00
 * Nairobi. Checked every 15 minutes so a restart still sends them; each goes
 * out once a day.
 */
export const cardReceiptRemindersJob: StationJob = {
  name: "card-receipt-reminders",
  everyMs: 15 * 60_000,
  lockKey: 72_046,
  run: runCardReceiptReminders().pipe(
    Effect.map((run) =>
      run === null || (run.reminded === 0 && run.failed === 0) ? IDLE : run,
    ),
  ),
};
