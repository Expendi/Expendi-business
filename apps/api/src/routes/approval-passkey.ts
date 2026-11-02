import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { passkeyRegistrationSchema } from "@expendi-business/shared";

import type { AuthVariables } from "../middleware/auth.js";
import type { AppRuntime } from "../runtime.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import {
  approvalPasskeyStatus,
  finishApprovalPasskeyEnrolment,
  startApprovalPasskeyEnrolment,
} from "../services/approval/enrolment.js";

const verifySchema = z.object({
  response: z.custom<RegistrationResponseJSON>(
    (value) => passkeyRegistrationSchema.safeParse(value).success,
    "Your passkey couldn't be read. Try again.",
  ),
});

/**
 * Mounted at `/me/approval-passkey`, behind authentication. The passkey
 * belongs to the person, whichever companies they approve for.
 */
export function createApprovalPasskeyRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: AuthVariables }> {
  return new Hono<{ Variables: AuthVariables }>()
    .get("/", (c) =>
      runEffect(runtime, c, approvalPasskeyStatus(c.get("userId"))),
    )
    .post("/options", (c) =>
      runEffect(
        runtime,
        c,
        startApprovalPasskeyEnrolment({
          userId: c.get("userId"),
          privyUserId: c.get("privyUserId"),
          tokenIssuedAt: c.get("tokenIssuedAt"),
        }),
      ),
    )
    .post("/verify", (c) => {
      const userId = c.get("userId");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, verifySchema).pipe(
          Effect.flatMap(({ response }) =>
            finishApprovalPasskeyEnrolment(userId, response),
          ),
        ),
        201,
      );
    });
}
