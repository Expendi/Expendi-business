import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  inviteMemberRequestSchema,
  updateMemberRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
} from "../services/membership/members.js";

const membershipIdSchema = z.uuid();

function membershipIdFrom(raw: string): Effect.Effect<string, NotFound> {
  const parsed = membershipIdSchema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new NotFound({ message: "That person isn't in this company." }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/members`. Admins only (spec §4,
 * §6.2): the team list, invites, role changes and removals.
 */
export function createMemberRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) => runEffect(runtime, c, listMembers(c.get("tenant"))))
    .post("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, inviteMemberRequestSchema).pipe(
          Effect.flatMap((invitation) => inviteMember(tenant, invitation)),
        ),
        201,
      );
    })
    .patch("/:membershipId", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        Effect.all([
          membershipIdFrom(c.req.param("membershipId")),
          readBody(c.req.raw, updateMemberRequestSchema),
        ]).pipe(
          Effect.flatMap(([membershipId, { role }]) =>
            changeMemberRole(tenant, membershipId, role),
          ),
        ),
      );
    })
    .delete("/:membershipId", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        membershipIdFrom(c.req.param("membershipId")).pipe(
          Effect.flatMap((membershipId) => removeMember(tenant, membershipId)),
        ),
      );
    });
}
