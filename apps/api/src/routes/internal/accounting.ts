import type { Context } from "hono";
import { Effect } from "effect";
import { Hono } from "hono";

import {
  chooseZohoOrganizationSchema,
  zohoMappingSchema,
} from "@expendi-business/shared";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { readBody } from "../../http/body.js";
import { runEffect } from "../../http/respond.js";
import { requireStaffRole } from "../../middleware/staff-auth.js";
import {
  chooseZohoOrganization,
  listZohoAccounts,
  listZohoOrganizations,
  saveZohoMapping,
} from "../../services/zoho/books.js";
import {
  createConnectLink,
  disconnectZoho,
  zohoStatus,
} from "../../services/zoho/connections.js";

type StaffContext = Context<{ Variables: StaffVariables }>;

const companyId = (c: StaffContext): string =>
  c.req.param("organizationId") ?? "";

/**
 * Mounted at `/internal/companies/:organizationId/zoho`, behind staff login
 * (spec §6.15, §6.17). Every staff member can look; changes need
 * `ops_admin`. No response carries a Zoho token or a link's hash.
 */
export function createZohoStaffRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  const opsAdmin = requireStaffRole("ops_admin");
  return new Hono<{ Variables: StaffVariables }>()
    .get("/", (c) => runEffect(runtime, c, zohoStatus(companyId(c))))
    .post("/connect-link", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        createConnectLink(c.get("staff"), companyId(c)),
        201,
      ),
    )
    .get("/organizations", (c) =>
      runEffect(runtime, c, listZohoOrganizations(companyId(c))),
    )
    .post("/organization", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, chooseZohoOrganizationSchema).pipe(
          Effect.flatMap((body) =>
            chooseZohoOrganization(c.get("staff"), companyId(c), body),
          ),
        ),
      ),
    )
    .get("/accounts", (c) =>
      runEffect(runtime, c, listZohoAccounts(companyId(c))),
    )
    .put("/mapping", opsAdmin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, zohoMappingSchema).pipe(
          Effect.flatMap((mapping) =>
            saveZohoMapping(c.get("staff"), companyId(c), mapping),
          ),
        ),
      ),
    )
    .post("/disconnect", opsAdmin, (c) =>
      runEffect(runtime, c, disconnectZoho(c.get("staff"), companyId(c))),
    );
}
