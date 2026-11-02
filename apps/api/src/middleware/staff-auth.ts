import type { RequestIdVariables } from "hono/request-id";
import { Exit } from "effect";
import { createMiddleware } from "hono/factory";

import type { StaffRole } from "@expendi-business/shared";

import type { AppRuntime } from "../runtime.js";
import type { StaffMember } from "../services/staff/staff-auth.js";
import { Forbidden, Unauthorized } from "../errors.js";
import { clientErrorResponse, failureResponse } from "../http/respond.js";
import { authenticateStaff } from "../services/staff/staff-auth.js";
import { BEARER } from "./auth.js";

/** Set by `staffAuthMiddleware` on every `/internal/*` request. */
export interface StaffVariables extends RequestIdVariables {
  staff: StaffMember;
}

const missingToken = new Unauthorized({ message: "Unauthorized" });

/**
 * Requires `Authorization: Bearer <Privy access token>` whose email is an
 * active staff member. A missing or invalid token gets 401; any other email
 * gets 403.
 */
export function staffAuthMiddleware(runtime: AppRuntime) {
  return createMiddleware<{ Variables: StaffVariables }>(async (c, next) => {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return clientErrorResponse(c, missingToken);

    const exit = await runtime.runPromiseExit(authenticateStaff(token));
    if (Exit.isFailure(exit)) return failureResponse(c, exit.cause);

    c.set("staff", exit.value);
    await next();
  });
}

/**
 * Runs after `staffAuthMiddleware`. Roles are enforced here, in the API, not
 * only in the admin app (spec §6.15): every action endpoint takes
 * `requireStaffRole("ops_admin")`.
 */
export function requireStaffRole(...roles: readonly StaffRole[]) {
  const forbidden = new Forbidden({
    message: "Your staff role can't do this",
  });
  return createMiddleware<{ Variables: StaffVariables }>(async (c, next) => {
    if (!roles.includes(c.get("staff").role)) {
      return clientErrorResponse(c, forbidden);
    }
    await next();
  });
}
