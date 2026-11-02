import type { Context } from "hono";
import { Effect } from "effect";
import { Hono } from "hono";

import {
  pausePrepareRequestSchema,
  staffConfirmRequestSchema,
} from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import type { PauseAction } from "../../services/staff/pause.js";
import { readBody } from "../../http/body.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import {
  confirmPause,
  controlsState,
  preparePause,
} from "../../services/staff/pause.js";

/**
 * Mounted at `/internal`, behind staff login (spec §6.15, §7.6). Every staff
 * role can see what's paused; only an ops admin can pause or unpause, with a
 * reason and a second confirmation.
 */
export function createControlRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  const opsAdmin = requireStaffRole("ops_admin");

  const prepare =
    (action: PauseAction) => (c: Context<{ Variables: StaffVariables }>) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, pausePrepareRequestSchema).pipe(
          Effect.flatMap((request) =>
            preparePause(c.get("staff"), action, {
              organizationId:
                request.scope === "company"
                  ? (request.organizationId ?? null)
                  : null,
              reason: request.reason,
            }),
          ),
        ),
        201,
      );

  const confirm =
    (action: PauseAction) => (c: Context<{ Variables: StaffVariables }>) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, staffConfirmRequestSchema).pipe(
          Effect.flatMap(({ token }) =>
            confirmPause(c.get("staff"), action, token),
          ),
        ),
      );

  return new Hono<{ Variables: StaffVariables }>()
    .get("/controls", (c) => runEffect(runtime, c, controlsState()))
    .post("/controls/pause/prepare", opsAdmin, prepare("pause"))
    .post("/controls/pause/confirm", opsAdmin, confirm("pause"))
    .post("/controls/unpause/prepare", opsAdmin, prepare("unpause"))
    .post("/controls/unpause/confirm", opsAdmin, confirm("unpause"));
}
