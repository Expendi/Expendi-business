import type { StationJob } from "./scheduler.js";
import { advanceBillStatuses } from "../services/bills/status.js";

/**
 * Moves bills from upcoming to due to overdue by Nairobi date (spec
 * §6.20). It's a daily change, checked every 15 minutes so bills turn soon
 * after Nairobi midnight even across restarts; a run with nothing to move
 * changes nothing.
 */
export const billStatusJob: StationJob = {
  name: "bill-status",
  everyMs: 15 * 60_000,
  lockKey: 72_035,
  run: advanceBillStatuses(),
};
