import { Effect } from "effect";
import { Hono } from "hono";

import {
  payoutQueueQuerySchema,
  resolvePrepareRequestSchema,
  staffConfirmRequestSchema,
} from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readBody } from "../../http/body.js";
import { readQuery } from "../../http/query.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import {
  payoutDetail,
  payoutQueue,
  refetchPayout,
} from "../../services/staff/payouts.js";
import {
  confirmResolution,
  prepareResolution,
} from "../../services/staff/resolve.js";

/**
 * Mounted at `/internal`, behind staff login (spec §6.15). Every staff role
 * can look; only an ops admin can re-fetch or resolve. Nothing here creates,
 * approves, funds or retries a payout: resolving closes one under review,
 * and re-fetching runs the ordinary forward-only sync.
 */
export function createPayoutRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  const opsAdmin = requireStaffRole("ops_admin");
  return new Hono<{ Variables: StaffVariables }>()
    .get("/payouts", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), payoutQueueQuerySchema).pipe(
          Effect.flatMap(payoutQueue),
        ),
      ),
    )
    .get("/payouts/:payoutId", (c) =>
      runEffect(runtime, c, payoutDetail(c.req.param("payoutId"))),
    )
    .post("/payouts/:payoutId/refetch", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        refetchPayout(c.get("staff"), c.req.param("payoutId")),
      ),
    )
    .post("/payouts/:payoutId/resolve/prepare", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, resolvePrepareRequestSchema).pipe(
          Effect.flatMap((request) =>
            prepareResolution(c.get("staff"), c.req.param("payoutId"), request),
          ),
        ),
        201,
      ),
    )
    .post("/payouts/:payoutId/resolve/confirm", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, staffConfirmRequestSchema).pipe(
          Effect.flatMap(({ token }) =>
            confirmResolution(c.get("staff"), c.req.param("payoutId"), token),
          ),
        ),
      ),
    );
}
