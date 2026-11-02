import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  createWithdrawalRequestSchema,
  passkeyAssertionSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../errors.js";
import { readBody } from "../http/body.js";
import { payoutRejectionAsClientError } from "../http/payout-rejection.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  confirmWithdrawal,
  requestWithdrawal,
} from "../services/withdrawal/withdrawals.js";

const confirmSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

/**
 * Mounted at `/organizations/:organizationId/withdrawals`. Admins only:
 * staff and other roles never move a company's money (spec §4, §6.9).
 */
export function createWithdrawalRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .post("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, createWithdrawalRequestSchema).pipe(
          Effect.flatMap((body) =>
            requestWithdrawal({
              organizationId: tenant.organizationId,
              userId: tenant.userId,
              requestId: body.requestId,
              addressId: body.addressId,
              amountUsdc: BigInt(body.amountUsdc),
            }),
          ),
          Effect.catchTags({
            PayoutRejected: (error) =>
              Effect.fail(payoutRejectionAsClientError(error)),
            PaycrestError: () =>
              Effect.fail(
                new ServiceUnavailable({
                  message:
                    "Couldn't get today's KES rate to record this withdrawal. Try again in a minute.",
                }),
              ),
            AmountTooSmall: () =>
              Effect.fail(
                new BadRequest({ message: "That amount is too small." }),
              ),
          }),
        ),
        201,
      );
    })
    .post("/:challengeId/confirm", (c) => {
      const tenant = c.get("tenant");
      const challengeId = c.req.param("challengeId");
      return runEffect(
        runtime,
        c,
        (z.uuid().safeParse(challengeId).success
          ? Effect.void
          : Effect.fail(
              new NotFound({ message: "That withdrawal wasn't found." }),
            )
        ).pipe(
          Effect.zipRight(readBody(c.req.raw, confirmSchema)),
          Effect.flatMap(({ response }) =>
            confirmWithdrawal({
              organizationId: tenant.organizationId,
              userId: tenant.userId,
              challengeId,
              response,
            }),
          ),
          Effect.catchTag("PayoutRejected", (error) =>
            Effect.fail(payoutRejectionAsClientError(error)),
          ),
        ),
      );
    });
}
