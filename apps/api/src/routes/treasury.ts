import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  passkeyAssertionSchema,
  turnOnTreasuryRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  confirmTurnOnTreasury,
  getTreasuryStatus,
  startTurnOnTreasuryConfirmation,
} from "../services/treasury/turn-on.js";

/** The schema's response is the assertion shape, which the verifier reads as is. */
const confirmSchema = turnOnTreasuryRequestSchema.extend({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

/**
 * Mounted at `/organizations/:organizationId/treasury`. Admins and
 * accountants read; only an admin changes anything. Turning on takes two
 * steps: `POST /confirmations` asks for the passkey, `POST /` finishes it.
 */
export function createTreasuryRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) => runEffect(runtime, c, getTreasuryStatus(c.get("tenant"))))
    .post("/confirmations", (c) =>
      runEffect(
        runtime,
        c,
        startTurnOnTreasuryConfirmation(c.get("tenant")),
        201,
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, confirmSchema).pipe(
          Effect.flatMap(({ challengeId, response }) =>
            confirmTurnOnTreasury(c.get("tenant"), { challengeId, response }),
          ),
        ),
      ),
    );
}
