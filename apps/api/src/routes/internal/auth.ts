import { Effect } from "effect";
import { Hono } from "hono";

import type { StaffMeResponse } from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import type { StaffMember } from "../../services/staff/staff-auth.js";
import { runEffect } from "../../http/respond.js";
import { recordStaffSignIn } from "../../services/staff/staff-auth.js";

function toResponse({ email, role }: StaffMember): StaffMeResponse {
  return { email, role };
}

/** Mounted at `/internal`, behind staff login. Open to every staff role. */
export function createStaffAuthRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  return new Hono<{ Variables: StaffVariables }>()
    .get("/me", (c) =>
      runEffect(runtime, c, Effect.succeed(toResponse(c.get("staff")))),
    )
    .post("/session", (c) => {
      const staff = c.get("staff");
      return runEffect(
        runtime,
        c,
        recordStaffSignIn(staff).pipe(Effect.as(toResponse(staff))),
        201,
      );
    });
}
