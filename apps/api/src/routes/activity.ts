import { Effect } from "effect";
import { Hono } from "hono";

import {
  activityQuerySchema,
  COMPANY_READER_ROLES,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { readQuery } from "../http/query.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import { companyActivity } from "../services/audit/company-activity.js";

/**
 * Mounted at `/organizations/:organizationId/activity`: the company's own
 * audit log, read-only, for its admins and accountants (spec §6.13, §6.14).
 * Nothing here writes; the staff search under `/internal/audit` is separate.
 */
export function createActivityRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole(...COMPANY_READER_ROLES))
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), activityQuerySchema).pipe(
          Effect.flatMap((filters) =>
            companyActivity(c.get("tenant"), filters),
          ),
        ),
      ),
    );
}
