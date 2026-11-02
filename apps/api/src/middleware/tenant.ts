import { and, eq } from "drizzle-orm";
import { Exit } from "effect";
import { createMiddleware } from "hono/factory";

import type { MembershipRole } from "@expendi-business/shared";
import { COMPANY_READER_ROLES } from "@expendi-business/shared";

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

const viewOnly = new Forbidden({
  message: "Accountants can see this company but can't change anything",
});

/** Hono answers HEAD with the GET route, so both only read. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export const isReadRequest = (method: string): boolean =>
  READ_METHODS.has(method);

/**
 * Resolves `:organizationId` against the caller's active membership. A
 * malformed ID, an unknown company and a company the caller doesn't belong
 * to all get the same 403, so responses don't reveal which companies exist.
 *
 * Accountants only read (spec §4, §6.14): anything else they send is refused
 * here, for every company route, including ones added later.
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
    if (membership.role === "accountant" && !isReadRequest(c.req.method)) {
      return clientErrorResponse(c, viewOnly);
    }

    c.set("tenant", {
      organizationId,
      userId,
      membershipId: membership.id,
      role: membership.role,
    });
    await next();
  });
}

/** Runs after `tenantMiddleware`; other roles get 403 (spec §4). */
export function requireRole(...roles: readonly MembershipRole[]) {
  const forbidden = new Forbidden({
    message: "Your role in this company can't do this",
  });
  return createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    if (!roles.includes(c.get("tenant").role)) {
      return clientErrorResponse(c, forbidden);
    }
    await next();
  });
}

/**
 * For routes an admin manages that accountants also see (spec §4, §6.14):
 * reads are open to every role in `COMPANY_READER_ROLES`, and every other
 * method stays admin-only.
 */
export function requireAdminOrReader() {
  const reader = requireRole(...COMPANY_READER_ROLES);
  const admin = requireRole("admin");
  return createMiddleware<{ Variables: TenantVariables }>((c, next) =>
    isReadRequest(c.req.method) ? reader(c, next) : admin(c, next),
  );
}
