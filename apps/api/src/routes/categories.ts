import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  createCategoryRequestSchema,
  listCategoriesQuerySchema,
  readsWholeCompany,
  updateCategoryRequestSchema,
} from "@expendi-business/shared";

import type { Tenant, TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { Forbidden, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { readQuery } from "../http/query.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  createCategory,
  listCategories,
  setCategoryArchived,
  updateCategory,
} from "../services/organization/categories.js";

const uuid = z.uuid();

function categoryIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "That category wasn't found." }));
}

const notForYourRole = new Forbidden({
  message: "Your role in this company can't do this",
});

/** Only admins and accountants see the archived ones (settings). */
function canSeeArchived(
  tenant: Tenant,
  archived: boolean | undefined,
): Effect.Effect<void, Forbidden> {
  return archived && !readsWholeCompany(tenant.role)
    ? Effect.fail(notForYourRole)
    : Effect.void;
}

/**
 * Mounted at `/organizations/:organizationId/categories`. Every active member
 * reads the list to pick a category when recording spending; admins edit it
 * (spec §6.1, §6.14), and accountants see it read-only.
 */
export function createCategoryRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  const admin = requireRole("admin");
  return new Hono<{ Variables: TenantVariables }>()
    .get("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readQuery(c.req.query(), listCategoriesQuerySchema).pipe(
          Effect.tap(({ archived }) => canSeeArchived(tenant, archived)),
          Effect.flatMap(({ archived }) =>
            listCategories(tenant, { archived }),
          ),
        ),
      );
    })
    .post("/", admin, (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, createCategoryRequestSchema).pipe(
          Effect.flatMap((fields) => createCategory(c.get("tenant"), fields)),
        ),
        201,
      ),
    )
    .patch("/:categoryId", admin, (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          categoryIdFrom(c.req.param("categoryId")),
          readBody(c.req.raw, updateCategoryRequestSchema),
        ]).pipe(
          Effect.flatMap(([categoryId, changes]) =>
            updateCategory(c.get("tenant"), categoryId, changes),
          ),
        ),
      ),
    )
    .post("/:categoryId/archive", admin, (c) =>
      runEffect(
        runtime,
        c,
        categoryIdFrom(c.req.param("categoryId")).pipe(
          Effect.flatMap((categoryId) =>
            setCategoryArchived(c.get("tenant"), categoryId, true),
          ),
        ),
      ),
    )
    .post("/:categoryId/restore", admin, (c) =>
      runEffect(
        runtime,
        c,
        categoryIdFrom(c.req.param("categoryId")).pipe(
          Effect.flatMap((categoryId) =>
            setCategoryArchived(c.get("tenant"), categoryId, false),
          ),
        ),
      ),
    );
}
