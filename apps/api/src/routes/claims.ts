import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  approveClaimsRequestSchema,
  claimListQuerySchema,
  passkeyAssertionSchema,
  rejectClaimRequestSchema,
  submitClaimRequestSchema,
  updateClaimRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import type { PayoutRejected } from "../services/payout/payout-errors.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../errors.js";
import { readBody } from "../http/body.js";
import { payoutRejectionAsClientError } from "../http/payout-rejection.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  confirmClaimApproval,
  requestClaimApproval,
  requestClaimRetry,
} from "../services/expenses/claim-approval.js";
import {
  getClaim,
  listClaims,
  rejectClaim,
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

const confirmSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

/** Why the engine wouldn't prepare a payment, as the app shows it. */
const PREPARATION_FAILURES = {
  PayoutRejected: (error: PayoutRejected) =>
    Effect.fail(payoutRejectionAsClientError(error)),
  PaycrestError: () =>
    Effect.fail(
      new ServiceUnavailable({
        message:
          "Couldn't get today's KES rate from Paycrest. Try again in a minute.",
      }),
    ),
  AmountTooSmall: () =>
    Effect.fail(
      new BadRequest({
        message: "This claim is below the smallest amount Paycrest pays.",
      }),
    ),
} as const;

/**
 * Mounted at `/organizations/:organizationId/claims` (spec §5, §6.3, §6.7).
 * Any member submits their own; employees see only theirs and admins see
 * all. Only the person who submitted a claim edits it, until it's approved.
 * Only admins approve, pay, retry and reject.
 */
export function createClaimRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .post("/approval", requireRole("admin"), (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, approveClaimsRequestSchema).pipe(
          Effect.flatMap(({ claimIds }) =>
            requestClaimApproval(tenant, claimIds),
          ),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      );
    })
    .post("/approval/:challengeId/confirm", requireRole("admin"), (c) => {
      const tenant = c.get("tenant");
      const challengeId = c.req.param("challengeId");
      return runEffect(
        runtime,
        c,
        (z.uuid().safeParse(challengeId).success
          ? Effect.void
          : Effect.fail(
              new NotFound({
                message:
                  "That approval wasn't found. Start Approve & pay again.",
              }),
            )
        ).pipe(
          Effect.zipRight(readBody(c.req.raw, confirmSchema)),
          Effect.flatMap(({ response }) =>
            confirmClaimApproval(tenant, challengeId, response),
          ),
          Effect.catchTag("PayoutRejected", (error) =>
            Effect.fail(payoutRejectionAsClientError(error)),
          ),
        ),
      );
    })
    .post("/:claimId/retry", requireRole("admin"), (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        claimIdFrom(c.req.param("claimId")).pipe(
          Effect.flatMap((claimId) => requestClaimRetry(tenant, claimId)),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      );
    })
    .post("/:claimId/reject", requireRole("admin"), (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        Effect.all([
          claimIdFrom(c.req.param("claimId")),
          readBody(c.req.raw, rejectClaimRequestSchema),
        ]).pipe(
          Effect.flatMap(([claimId, { reason }]) =>
            rejectClaim(tenant, claimId, reason),
          ),
        ),
      );
    })
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
