import { Effect } from "effect";
import { Hono } from "hono";

import { companySearchQuerySchema } from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readQuery } from "../../http/query.js";
import { runEffect } from "../../http/respond.js";
import {
  companyDetail,
  searchCompanies,
} from "../../services/staff/companies.js";
import { staffTreasury } from "../../services/staff/treasury.js";

/** Mounted at `/internal`, behind staff login. Read-only, for every staff role. */
export function createCompanyRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  return new Hono<{ Variables: StaffVariables }>()
    .get("/companies", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), companySearchQuerySchema).pipe(
          Effect.flatMap(({ search, pausedOnly, cursor, limit }) =>
            searchCompanies({
              search,
              pausedOnly: pausedOnly === "true",
              cursor,
              limit,
            }),
          ),
        ),
      ),
    )
    .get("/companies/:organizationId", (c) =>
      runEffect(runtime, c, companyDetail(c.req.param("organizationId"))),
    )
    .get("/companies/:organizationId/treasury", (c) =>
      runEffect(runtime, c, staffTreasury(c.req.param("organizationId"))),
    );
}
