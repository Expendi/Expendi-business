import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";

import type { MeResponse } from "@expendi-business/shared";
import {
  confirmPayoutPhoneRequestSchema,
  expoPushTokenSchema,
  registerPushTokenRequestSchema,
  resendPayoutPhoneCodeRequestSchema,
  startPayoutPhoneRequestSchema,
  updateMeRequestSchema,
} from "@expendi-business/shared";

import type { AuthVariables } from "../middleware/auth.js";
import type { AppRuntime } from "../runtime.js";
import { memberships, organizations, users } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { BadRequest } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { activateInvitedMemberships } from "../services/membership/activation.js";
import {
  registerPushToken,
  unregisterPushToken,
} from "../services/notification/push-tokens.js";
import {
  confirmPayoutPhone,
  resendPayoutPhoneCode,
  startPayoutPhoneVerification,
} from "../services/phone-verification/payout-phone.js";
import { updateFullName } from "../services/users/full-name.js";

function pushTokenFrom(raw: string): Effect.Effect<string, BadRequest> {
  const parsed = expoPushTokenSchema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({ message: "That isn't an Expo push token." }),
      );
}

/**
 * Mounted at `/me`, behind authentication. The app loads it at sign-in, so
 * it first activates invites sent to someone who already had a login. The
 * payout-number routes (spec §6.18), the person's name (§6.2) and their
 * devices' push tokens (§6.10) belong to the person, not a company.
 */
export function createMeRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: AuthVariables }> {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        activateInvitedMemberships(userId).pipe(
          Effect.zipRight(
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
                  : Effect.dieMessage(
                      `authenticated user ${userId} has no row`,
                    ),
              ),
            ),
          ),
        ),
      );
    })
    .patch("/", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, updateMeRequestSchema).pipe(
          Effect.flatMap(({ fullName }) => updateFullName(userId, fullName)),
        ),
      );
    })
    .post("/payout-phone", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, startPayoutPhoneRequestSchema).pipe(
          Effect.flatMap(({ phone }) =>
            startPayoutPhoneVerification(userId, phone),
          ),
        ),
        201,
      );
    })
    .post("/payout-phone/resend", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, resendPayoutPhoneCodeRequestSchema).pipe(
          Effect.flatMap(({ challengeId }) =>
            resendPayoutPhoneCode(userId, challengeId),
          ),
        ),
      );
    })
    .post("/payout-phone/confirm", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, confirmPayoutPhoneRequestSchema).pipe(
          Effect.flatMap(({ challengeId, code }) =>
            confirmPayoutPhone(userId, challengeId, code),
          ),
        ),
      );
    })
    .post("/push-tokens", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, registerPushTokenRequestSchema).pipe(
          Effect.flatMap((request) => registerPushToken(userId, request)),
        ),
      );
    })
    .delete("/push-tokens/:token", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        pushTokenFrom(c.req.param("token")).pipe(
          Effect.flatMap((token) => unregisterPushToken(userId, token)),
        ),
      );
    });
}
