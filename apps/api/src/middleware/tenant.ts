import { and, eq } from "drizzle-orm";
import { Exit } from "effect";
import { createMiddleware } from "hono/factory";

import type { MembershipRole } from "@expendi-business/shared";

import type { AppRuntime } from "../runtime.js";
import type { AuthVariables } from "./auth.js";
import { memberships } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { Forbidden } from "../errors.js";
import { clientErrorResponse, failureResponse } from "../http/respond.js";

/** The company a request acts on, proven by the caller's active membership. */
export interface Tenant {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly role: MembershipRole;
}

export interface TenantVariables extends AuthVariables {
  tenant: Tenant;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noAccess = new Forbidden({
  message: "You don't have access to this company",
});

/**
 * Resolves `:organizationId` against the caller's active membership. A
 * malformed ID, an unknown company and a company the caller doesn't belong
 * to all get the same 403, so responses don't reveal which companies exist.
 */
export function tenantMiddleware(runtime: AppRuntime) {
  return createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    const organizationId = c.req.param("organizationId");
    const userId = c.get("userId");
    if (!organizationId || !UUID.test(organizationId)) {
      return clientErrorResponse(c, noAccess);
    }

    const exit = await runtime.runPromiseExit(
      withScope({ userId }, (tx) =>
        query(() =>
          tx
            .select({ id: memberships.id, role: memberships.role })
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, userId),
                eq(memberships.organizationId, organizationId),
                eq(memberships.status, "active"),
              ),
            )
            .limit(1),
        ),
      ),
    );
    if (Exit.isFailure(exit)) return failureResponse(c, exit.cause);

    const [membership] = exit.value;
    if (!membership) return clientErrorResponse(c, noAccess);

    c.set("tenant", {
      organizationId,
      userId,
      membershipId: membership.id,
      role: membership.role,
    });
    await next();
  });
}
