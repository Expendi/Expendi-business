import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  createRecurringItemRequestSchema,
  RECURRING_ITEMS_LIST_MAX_SIZE,
  updateRecurringItemRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  createRecurringItem,
  endRecurringItem,
  getRecurringItem,
  listRecurringItems,
  pauseRecurringItem,
  resumeRecurringItem,
  updateRecurringItem,
} from "../services/recurring/recurring-items.js";

const uuid = z.uuid();

function itemIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(
        new NotFound({ message: "That recurring payment wasn't found." }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/recurring-items`. Admins only
 * (spec §4); row-level security hides recurring payments from every other
 * role as well.
 */
export function createRecurringItemRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        listRecurringItems(c.get("tenant"), RECURRING_ITEMS_LIST_MAX_SIZE),
      ),
    )
    .get("/:itemId", (c) =>
      runEffect(
        runtime,
        c,
        itemIdFrom(c.req.param("itemId")).pipe(
          Effect.flatMap((itemId) => getRecurringItem(c.get("tenant"), itemId)),
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, createRecurringItemRequestSchema).pipe(
          Effect.flatMap((fields) =>
            createRecurringItem(c.get("tenant"), fields),
          ),
        ),
        201,
      ),
    )
    .patch("/:itemId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          itemIdFrom(c.req.param("itemId")),
          readBody(c.req.raw, updateRecurringItemRequestSchema),
        ]).pipe(
          Effect.flatMap(([itemId, changes]) =>
            updateRecurringItem(c.get("tenant"), itemId, changes),
          ),
        ),
      ),
    )
    .post("/:itemId/pause", (c) =>
      runEffect(
        runtime,
        c,
        itemIdFrom(c.req.param("itemId")).pipe(
          Effect.flatMap((itemId) =>
            pauseRecurringItem(c.get("tenant"), itemId),
          ),
        ),
      ),
    )
    .post("/:itemId/resume", (c) =>
      runEffect(
        runtime,
        c,
        itemIdFrom(c.req.param("itemId")).pipe(
          Effect.flatMap((itemId) =>
            resumeRecurringItem(c.get("tenant"), itemId),
          ),
        ),
      ),
    )
    .post("/:itemId/end", (c) =>
      runEffect(
        runtime,
        c,
        itemIdFrom(c.req.param("itemId")).pipe(
          Effect.flatMap((itemId) => endRecurringItem(c.get("tenant"), itemId)),
        ),
      ),
    );
}
