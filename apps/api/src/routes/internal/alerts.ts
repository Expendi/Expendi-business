import { Hono } from "hono";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { runEffect } from "../../http/respond.js";
import { listOpsAlerts, systemHealth } from "../../services/staff/alerts.js";

/**
 * Mounted at `/internal`, behind staff login: every staff role may look
 * (spec §6.16). There is nothing to act on; alerts open and resolve on
 * their own.
 */
export function createAlertRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  return new Hono<{ Variables: StaffVariables }>()
    .get("/alerts", (c) => runEffect(runtime, c, listOpsAlerts()))
    .get("/health", (c) => runEffect(runtime, c, systemHealth()));
}
