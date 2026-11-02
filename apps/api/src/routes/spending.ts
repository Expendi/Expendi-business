import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  listCompanySpendingQuerySchema,
  recordCompanySpendingRequestSchema,
  updateCompanySpendingRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  getCompanySpending,
  listCompanySpending,
  recordCompanySpending,
  updateCompanySpending,
} from "../services/expenses/company.js";

const uuid = z.uuid();

function spendingIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "That spending wasn't found." }));
}

function parseQuery(
  query: Record<string, string>,
): Effect.Effect<z.output<typeof listCompanySpendingQuerySchema>, BadRequest> {
  const parsed = listCompanySpendingQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid filters",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/company-spending`. Admins only
 * (spec §4, §6.23). Receipts are uploaded, pasted and read through the
 * receipts routes first, as for a claim.
 */
export function createCompanySpendingRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(c.req.query()).pipe(
          Effect.flatMap((filters) =>
            listCompanySpending(c.get("tenant"), filters),
          ),
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, recordCompanySpendingRequestSchema).pipe(
          Effect.flatMap((fields) =>
            recordCompanySpending(c.get("tenant"), fields),
          ),
        ),
        201,
      ),
    )
    .get("/:spendingId", (c) =>
      runEffect(
        runtime,
        c,
        spendingIdFrom(c.req.param("spendingId")).pipe(
          Effect.flatMap((spendingId) =>
            getCompanySpending(c.get("tenant"), spendingId),
          ),
        ),
      ),
    )
    .patch("/:spendingId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          spendingIdFrom(c.req.param("spendingId")),
          readBody(c.req.raw, updateCompanySpendingRequestSchema),
        ]).pipe(
          Effect.flatMap(([spendingId, changes]) =>
            updateCompanySpending(c.get("tenant"), spendingId, changes),
          ),
        ),
      ),
    );
}
