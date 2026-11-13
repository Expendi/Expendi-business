import { Effect } from "effect";
import { Hono } from "hono";

import { runCardSimulationRequestSchema } from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readBody } from "../../http/body.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import {
  runStaffCardSimulation,
  staffCardSimulations,
} from "../../services/card-simulations/staff.js";

/**
 * Mounted at `/internal`, behind staff login. Sandbox only (spec §6.25):
 * every staff role can see a company's card-paid recurring payments; only
 * an ops admin can make the pretend merchant's Card purchase for one. The
 * purchase spends from the company's Card balance at Lithic's sandbox and
 * never touches the wallet or a payout.
 */
export function createCardSimulationRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  return new Hono<{ Variables: StaffVariables }>()
    .get("/companies/:organizationId/card-simulations", (c) =>
      runEffect(
        runtime,
        c,
        staffCardSimulations(c.req.param("organizationId")),
      ),
    )
    .post(
      "/companies/:organizationId/card-simulations",
      requireStaffRole("ops_admin"),
      (c) =>
        runEffect(
          runtime,
          c,
          readBody(c.req.raw, runCardSimulationRequestSchema).pipe(
            Effect.flatMap((request) =>
              runStaffCardSimulation(
                c.get("staff"),
                c.req.param("organizationId"),
                request,
              ),
            ),
          ),
          201,
        ),
    );
}
