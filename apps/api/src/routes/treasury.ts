import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  passkeyAssertionSchema,
  startTreasuryMoveRequestSchema,
  treasuryMoveRequestSchema,
  turnOnTreasuryRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import { getTreasuryStatus } from "../services/treasury/figures.js";
import {
  listTreasuryMoves,
  previewTreasuryMove,
  startMoveConfirmation,
  startTreasuryMove,
  toMoveSummary,
} from "../services/treasury/moves.js";
import {
  confirmTurnOnTreasury,
  startTurnOnTreasuryConfirmation,
} from "../services/treasury/turn-on.js";

/** The schema's response is the assertion shape, which the verifier reads as is. */
const confirmSchema = turnOnTreasuryRequestSchema.extend({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

const startMoveSchema = startTreasuryMoveRequestSchema.extend({
  response: confirmSchema.shape.response,
});

/** `"all"` stays a word; every other amount is a base-unit integer string. */
const amountOf = (amountUsdc: string): bigint | "all" =>
  amountUsdc === "all" ? "all" : BigInt(amountUsdc);

/**
 * Mounted at `/organizations/:organizationId/treasury`. Admins and
 * accountants read; only an admin changes anything. Turning on takes two
 * steps: `POST /confirmations` asks for the passkey, `POST /` finishes it.
 * Moves under `/moves` work the same way: `POST /moves/preview` prices one,
 * `POST /moves/confirmations` asks for the passkey for that direction and
 * amount, `POST /moves` starts it.
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
    )
    .post("/moves/preview", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, treasuryMoveRequestSchema).pipe(
          Effect.flatMap(({ direction, amountUsdc }) =>
            previewTreasuryMove(c.get("tenant"), {
              direction,
              amountUsdc: amountOf(amountUsdc),
            }),
          ),
        ),
      ),
    )
    .post("/moves/confirmations", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, treasuryMoveRequestSchema).pipe(
          Effect.flatMap(({ direction, amountUsdc }) =>
            startMoveConfirmation(c.get("tenant"), {
              direction,
              amountUsdc: amountOf(amountUsdc),
            }),
          ),
        ),
        201,
      ),
    )
    .post("/moves", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, startMoveSchema).pipe(
          Effect.flatMap(({ direction, amountUsdc, challengeId, response }) =>
            startTreasuryMove(c.get("tenant"), {
              direction,
              amountUsdc: amountOf(amountUsdc),
              challengeId,
              response,
            }),
          ),
          Effect.map(toMoveSummary),
        ),
        201,
      ),
    )
    .get("/moves", (c) =>
      runEffect(runtime, c, listTreasuryMoves(c.get("tenant"))),
    );
}
