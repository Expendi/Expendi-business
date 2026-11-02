import type { StationJob } from "./scheduler.js";
import { draftDuePayrollRuns } from "../services/payroll/drafts.js";

/**
 * Drafts each company's payroll run 5 Nairobi days before its pay date
 * (spec §6.21). It's a daily change, checked every 15 minutes so a run
 * appears soon after Nairobi midnight even across restarts; a run with
 * nothing due changes nothing.
 */
export const payrollDraftsJob: StationJob = {
  name: "payroll-drafts",
  everyMs: 15 * 60_000,
  lockKey: 72_038,
  run: draftDuePayrollRuns(),
};
