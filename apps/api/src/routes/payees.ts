import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  changePayeeDetailsRequestSchema,
  createPayeeRequestSchema,
  listPayeesQuerySchema,
  passkeyAssertionSchema,
  payeeChangeSchema,
  updatePayeeRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, Forbidden, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  archivePayee,
  confirmPayeeChange,
  createPayee,
  getPayee,
  listPayeeBanks,
  listPayees,
  requestPayeeDetailsChange,
  restorePayee,
  updatePayee,
} from "../services/payees/payees.js";

const uuid = z.uuid();

function payeeIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "That payee wasn't found." }));
}

function challengeIdFrom(raw: string): Effect.Effect<string, Forbidden> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(
        new Forbidden({
          message:
            "This confirmation expired or was already used. Confirm again.",
        }),
      );
}

/** Only the assertion's shape is checked here; the verifier checks its signature. */
const confirmSchema = z.object({
  change: payeeChangeSchema,
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Confirm with your passkey.",
  ),
});

function parseQuery(
  query: Record<string, string>,
): Effect.Effect<z.output<typeof listPayeesQuerySchema>, BadRequest> {
  const parsed = listPayeesQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid filters",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/payees`. Admins, and accountants
 * read-only: payees hold bank and M-Pesa details (spec §4, §6.19). Adding
 * payment details or
 * changing them returns a passkey challenge, confirmed at
 * `/changes/:challengeId/confirm`. Archiving and restoring need no passkey:
 * a restored payee keeps the details it had.
 */
export function createPayeeRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(c.req.query()).pipe(
          Effect.flatMap((filters) => listPayees(c.get("tenant"), filters)),
        ),
      ),
    )
    .get("/banks", (c) => runEffect(runtime, c, listPayeeBanks()))
    .get("/:payeeId", (c) =>
      runEffect(
        runtime,
        c,
        payeeIdFrom(c.req.param("payeeId")).pipe(
          Effect.flatMap((payeeId) => getPayee(c.get("tenant"), payeeId)),
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, createPayeeRequestSchema).pipe(
          Effect.flatMap((input) => createPayee(c.get("tenant"), input)),
        ),
      ),
    )
    .post("/changes/:challengeId/confirm", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          challengeIdFrom(c.req.param("challengeId")),
          readBody(c.req.raw, confirmSchema),
        ]).pipe(
          Effect.flatMap(([challengeId, { change, response }]) =>
            confirmPayeeChange(c.get("tenant"), {
              challengeId,
              change,
              response,
            }),
          ),
        ),
      ),
    )
    .patch("/:payeeId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          payeeIdFrom(c.req.param("payeeId")),
          readBody(c.req.raw, updatePayeeRequestSchema),
        ]).pipe(
          Effect.flatMap(([payeeId, update]) =>
            updatePayee(c.get("tenant"), payeeId, update),
          ),
        ),
      ),
    )
    .post("/:payeeId/details", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          payeeIdFrom(c.req.param("payeeId")),
          readBody(c.req.raw, changePayeeDetailsRequestSchema),
        ]).pipe(
          Effect.flatMap(([payeeId, { details }]) =>
            requestPayeeDetailsChange(c.get("tenant"), payeeId, details),
          ),
        ),
      ),
    )
    .post("/:payeeId/archive", (c) =>
      runEffect(
        runtime,
        c,
        payeeIdFrom(c.req.param("payeeId")).pipe(
          Effect.flatMap((payeeId) => archivePayee(c.get("tenant"), payeeId)),
        ),
      ),
    )
    .post("/:payeeId/restore", (c) =>
      runEffect(
        runtime,
        c,
        payeeIdFrom(c.req.param("payeeId")).pipe(
          Effect.flatMap((payeeId) => restorePayee(c.get("tenant"), payeeId)),
        ),
      ),
    );
}
