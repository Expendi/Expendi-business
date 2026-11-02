import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { overviewQuerySchema } from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readQuery } from "../http/query.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  getOverviewPerson,
  getSpendingOverview,
} from "../services/overview/overview.js";

const uuid = z.uuid();

function personIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "Person not found" }));
}

/**
 * Mounted at `/organizations/:organizationId/overview` (spec §6.24). Admins,
 * and accountants read-only (spec §4). Employees' home screen reads only
 * their own claims, floats and salary payments, from those routes.
 */
export function createOverviewRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), overviewQuerySchema).pipe(
          Effect.flatMap(({ month }) =>
            getSpendingOverview(c.get("tenant"), month),
          ),
        ),
      ),
    )
    .get("/people/:personId", (c) =>
      runEffect(
        runtime,
        c,
        personIdFrom(c.req.param("personId")).pipe(
          Effect.flatMap((personId) =>
            getOverviewPerson(c.get("tenant"), personId),
          ),
        ),
      ),
    );
}
