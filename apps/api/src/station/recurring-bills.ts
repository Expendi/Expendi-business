import type { StationJob } from "./scheduler.js";
import { createOwedRecurringBills } from "../services/recurring/next-bill.js";

/**
 * Gives every active recurring payment with no bill still owed its next
 * bill (spec §6.20). Settling a bill does that straight away; this is
 * the safety net for any path that didn't.
 * Checked every 15 minutes like the bill status job; a run with nothing
 * owed changes nothing.
 */
export const recurringBillsJob: StationJob = {
  name: "recurring-bills",
  everyMs: 15 * 60_000,
  lockKey: 72_036,
  run: createOwedRecurringBills(),
};
