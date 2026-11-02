import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  claimListQuerySchema,
  submitClaimRequestSchema,
  updateClaimRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import {
  getClaim,
  listClaims,
  submitClaim,
  updateClaim,
} from "../services/expenses/claims.js";

const claimIdSchema = z.uuid();

function claimIdFrom(raw: string): Effect.Effect<string, NotFound> {
  const parsed = claimIdSchema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new NotFound({ message: "Claim not found" }));
}

function readListQuery(
  query: Record<string, string>,
): Effect.Effect<z.output<typeof claimListQuerySchema>, BadRequest> {
  const parsed = claimListQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid query",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/claims` (spec §5, §6.3). Any
 * member submits their own; employees see only theirs and admins see all.
 * Only the person who submitted a claim edits it, until it's approved.
 */
export function createClaimRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .get("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readListQuery(c.req.query()).pipe(
          Effect.flatMap((options) => listClaims(tenant, options)),
        ),
      );
    })
    .post("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, submitClaimRequestSchema).pipe(
          Effect.flatMap((fields) => submitClaim(tenant, fields)),
        ),
        201,
      );
    })
    .get("/:claimId", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        claimIdFrom(c.req.param("claimId")).pipe(
          Effect.flatMap((claimId) => getClaim(tenant, claimId)),
        ),
      );
    })
    .patch("/:claimId", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        Effect.all([
          claimIdFrom(c.req.param("claimId")),
          readBody(c.req.raw, updateClaimRequestSchema),
        ]).pipe(
          Effect.flatMap(([claimId, changes]) =>
            updateClaim(tenant, claimId, changes),
          ),
        ),
      );
    });
}
