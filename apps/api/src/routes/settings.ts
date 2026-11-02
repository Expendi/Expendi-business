import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  changePayrollMarginRequestSchema,
  passkeyAssertionSchema,
  payrollMarginChangeSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { Forbidden } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  confirmPayrollMarginChange,
  getPayrollMargin,
  requestPayrollMarginChange,
} from "../services/payroll/margin.js";

const confirmSchema = z.object({
  change: payrollMarginChangeSchema,
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Confirm with your passkey.",
  ),
});

function challengeIdFrom(raw: string): Effect.Effect<string, Forbidden> {
  return z.uuid().safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(
        new Forbidden({
          message:
            "This confirmation expired or was already used. Confirm again.",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/settings`. Admins, and
 * accountants read-only (spec §4). The payroll cap's margin (spec §7.4)
 * changes with the admin's passkey, confirmed at
 * `/payroll-margin/:challengeId/confirm`.
 */
export function createSettingsRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/payroll-margin", (c) =>
      runEffect(runtime, c, getPayrollMargin(c.get("tenant"))),
    )
    .post("/payroll-margin", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, changePayrollMarginRequestSchema).pipe(
          Effect.flatMap(({ marginPct }) =>
            requestPayrollMarginChange(c.get("tenant"), marginPct),
          ),
        ),
      ),
    )
    .post("/payroll-margin/:challengeId/confirm", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          challengeIdFrom(c.req.param("challengeId")),
          readBody(c.req.raw, confirmSchema),
        ]).pipe(
          Effect.flatMap(([challengeId, { change, response }]) =>
            confirmPayrollMarginChange(c.get("tenant"), {
              challengeId,
              change,
              response,
            }),
          ),
        ),
      ),
    );
}
