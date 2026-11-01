import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { organizations } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { NotFound } from "../errors.js";
import { runEffect } from "../http/respond.js";
import { tenantMiddleware } from "../middleware/tenant.js";
import { createAllowlistRoutes } from "./allowlist.js";
import { createWalletRoutes } from "./wallet.js";

/** Mounted at `/organizations/:organizationId`. */
export function createOrganizationRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(tenantMiddleware(runtime))
    .get("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        withScope(tenant, (tx) =>
          query(() =>
            tx
              .select({ id: organizations.id, name: organizations.name })
              .from(organizations)
              .where(eq(organizations.id, tenant.organizationId))
              .limit(1),
          ),
        ).pipe(
          Effect.flatMap(([organization]) =>
            organization
              ? Effect.succeed({ ...organization, role: tenant.role })
              : Effect.fail(new NotFound({ message: "Company not found" })),
          ),
        ),
      );
    })
    .route("/wallet", createWalletRoutes(runtime))
    .route("/withdrawal-addresses", createAllowlistRoutes(runtime));
}
