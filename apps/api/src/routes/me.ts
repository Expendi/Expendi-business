import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";

import type { MeResponse } from "@expendi-business/shared";

import type { AuthVariables } from "../middleware/auth.js";
import type { AppRuntime } from "../runtime.js";
import { memberships, organizations, users } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { runEffect } from "../http/respond.js";

/** Mounted at `/me`, behind authentication. */
export function createMeRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: AuthVariables }> {
  return new Hono<{ Variables: AuthVariables }>().get("/", (c) => {
    const userId = c.get("userId");
    return runEffect(
      runtime,
      c,
      withScope({ userId }, (tx) =>
        Effect.all({
          user: query(() =>
            tx
              .select({
                id: users.id,
                email: users.email,
                phone: users.phone,
                fullName: users.fullName,
              })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1),
          ),
          memberships: query(() =>
            tx
              .select({
                id: memberships.id,
                organizationId: memberships.organizationId,
                organizationName: organizations.name,
                role: memberships.role,
                status: memberships.status,
              })
              .from(memberships)
              .innerJoin(
                organizations,
                eq(organizations.id, memberships.organizationId),
              )
              .where(
                and(
                  eq(memberships.userId, userId),
                  ne(memberships.status, "removed"),
                ),
              )
              .orderBy(organizations.name),
          ),
        }),
      ).pipe(
        Effect.flatMap(({ user: [user], memberships }) =>
          user
            ? Effect.succeed({ user, memberships } satisfies MeResponse)
            : Effect.dieMessage(`authenticated user ${userId} has no row`),
        ),
      ),
    );
  });
}
