import { Hono } from "hono";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { runEffect } from "../http/respond.js";
import { listCategories } from "../services/organization/categories.js";

/**
 * Mounted at `/organizations/:organizationId/categories`. Every active member
 * picks a category when recording spending.
 */
export function createCategoryRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>().get("/", (c) =>
    runEffect(runtime, c, listCategories(c.get("tenant"))),
  );
}
