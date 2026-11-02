import { Effect } from "effect";
import { Hono } from "hono";

import { auditSearchQuerySchema } from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readQuery } from "../../http/query.js";
import { runEffect } from "../../http/respond.js";
import { searchAuditLog } from "../../services/staff/audit-search.js";

/**
 * Mounted at `/internal`, behind staff login: every staff role may search
 * (spec §6.15). Read-only by design; there is no route that writes to the
 * audit log, and `internal-routes.test.ts` keeps it so.
 */
export function createAuditRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  return new Hono<{ Variables: StaffVariables }>().get("/audit", (c) =>
    runEffect(
      runtime,
      c,
      readQuery(c.req.query(), auditSearchQuerySchema).pipe(
        Effect.flatMap(searchAuditLog),
      ),
    ),
  );
}
