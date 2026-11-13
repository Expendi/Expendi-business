import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  closeFloatRequestSchema,
  issueFloatRequestSchema,
  listFloatsQuerySchema,
  passkeyAssertionSchema,
  recordFloatReturnRequestSchema,
  recordFloatSpendingRequestSchema,
  topUpFloatRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import type { PayoutRejected } from "../services/payout/payout-errors.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../errors.js";
import { readBody } from "../http/body.js";
import { payoutRejectionAsClientError } from "../http/payout-rejection.js";
import { readQuery } from "../http/query.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import { closeFloat, recordFloatReturn } from "../services/floats/closing.js";
import {
  confirmFloatApproval,
  issueFloat,
  requestMovementApproval,
  topUpFloat,
} from "../services/floats/payments.js";
import { recordFloatSpending } from "../services/floats/spending.js";
import { getFloat, listFloats } from "../services/floats/views.js";

const uuid = z.uuid();

function idFrom(raw: string, message: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message }));
}

const floatIdFrom = (raw: string) => idFrom(raw, "Float not found");

const confirmSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

/** The active cash-out provider didn't answer while pricing a payment. */
const rateUnavailable = new ServiceUnavailable({
  message: "Couldn't get today's KES rate. Try again in a minute.",
});

/** Why the engine wouldn't prepare a payment, as the app shows it. */
const PREPARATION_FAILURES = {
  PayoutRejected: (error: PayoutRejected) =>
    Effect.fail(payoutRejectionAsClientError(error)),
  PaycrestError: () => Effect.fail(rateUnavailable),
  PretiumError: () => Effect.fail(rateUnavailable),
  AmountTooSmall: () =>
    Effect.fail(
      new BadRequest({
        message: "This is below the smallest amount that can be sent.",
      }),
    ),
} as const;

/**
 * Mounted at `/organizations/:organizationId/floats` (spec §6.22). Admins
 * issue, top up, record returns and close; every float's payment goes
 * through Approve & pay. The person holding a float records its spending.
 * Admins and accountants see every float, anyone else only their own.
 */
export function createFloatRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), listFloatsQuerySchema).pipe(
          Effect.flatMap((options) => listFloats(c.get("tenant"), options)),
        ),
      ),
    )
    .post("/", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, issueFloatRequestSchema).pipe(
          Effect.flatMap((input) => issueFloat(c.get("tenant"), input)),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      ),
    )
    .post("/approval/:challengeId/confirm", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        idFrom(
          c.req.param("challengeId"),
          "That approval wasn't found. Start again.",
        ).pipe(
          Effect.flatMap((challengeId) =>
            readBody(c.req.raw, confirmSchema).pipe(
              Effect.flatMap(({ response }) =>
                confirmFloatApproval(c.get("tenant"), challengeId, response),
              ),
            ),
          ),
          Effect.catchTag("PayoutRejected", (error) =>
            Effect.fail(payoutRejectionAsClientError(error)),
          ),
        ),
      ),
    )
    .get("/:floatId", (c) =>
      runEffect(
        runtime,
        c,
        floatIdFrom(c.req.param("floatId")).pipe(
          Effect.flatMap((floatId) => getFloat(c.get("tenant"), floatId)),
        ),
      ),
    )
    .post("/:floatId/top-ups", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          floatIdFrom(c.req.param("floatId")),
          readBody(c.req.raw, topUpFloatRequestSchema),
        ]).pipe(
          Effect.flatMap(([floatId, { amountKes }]) =>
            topUpFloat(c.get("tenant"), floatId, amountKes),
          ),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      ),
    )
    .post(
      "/:floatId/movements/:movementId/approval",
      requireRole("admin"),
      (c) =>
        runEffect(
          runtime,
          c,
          Effect.all([
            floatIdFrom(c.req.param("floatId")),
            idFrom(
              c.req.param("movementId"),
              "That float payment wasn't found.",
            ),
          ]).pipe(
            Effect.flatMap(([floatId, movementId]) =>
              requestMovementApproval(c.get("tenant"), floatId, movementId),
            ),
            Effect.catchTags(PREPARATION_FAILURES),
          ),
          201,
        ),
    )
    .post("/:floatId/spending", requireRole("admin", "employee"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          floatIdFrom(c.req.param("floatId")),
          readBody(c.req.raw, recordFloatSpendingRequestSchema),
        ]).pipe(
          Effect.flatMap(([floatId, fields]) =>
            recordFloatSpending(c.get("tenant"), floatId, fields),
          ),
        ),
        201,
      ),
    )
    .post("/:floatId/returns", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          floatIdFrom(c.req.param("floatId")),
          readBody(c.req.raw, recordFloatReturnRequestSchema),
        ]).pipe(
          Effect.flatMap(([floatId, fields]) =>
            recordFloatReturn(c.get("tenant"), floatId, fields),
          ),
        ),
        201,
      ),
    )
    .post("/:floatId/close", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          floatIdFrom(c.req.param("floatId")),
          readBody(c.req.raw, closeFloatRequestSchema),
        ]).pipe(
          Effect.flatMap(([floatId, { writeOffReason }]) =>
            closeFloat(c.get("tenant"), floatId, {
              writeOffReason: writeOffReason ?? null,
            }),
          ),
        ),
      ),
    );
}
