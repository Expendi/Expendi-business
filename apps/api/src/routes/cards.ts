import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  cardActionSchema,
  COMPANY_READER_ROLES,
  listCardsQuerySchema,
  lowerCardLimitRequestSchema,
  passkeyAssertionSchema,
  turnOnCardsRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { readQuery } from "../http/query.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  confirmCardAction,
  startCardConfirmation,
} from "../services/cards/confirmations.js";
import {
  closeCard,
  freezeCard,
  lowerCardLimit,
} from "../services/cards/manage.js";
import { turnOnCards } from "../services/cards/program.js";
import {
  getCard,
  getCardProgram,
  listCardLoads,
  listCards,
} from "../services/cards/views.js";

const uuid = z.uuid();

function idFrom(raw: string, message: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message }));
}

const cardIdFrom = (raw: string) => idFrom(raw, "That card wasn't found.");

/** The action comes back with the signature; the passkey is bound to it. */
const confirmSchema = z.object({
  action: cardActionSchema,
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

/** Mounted at `/organizations/:organizationId/cards` (spec §6.25). */
export function createCardRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .get("/program", (c) =>
      runEffect(runtime, c, getCardProgram(c.get("tenant"))),
    )
    .post("/program", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, turnOnCardsRequestSchema).pipe(
          Effect.flatMap((fields) => turnOnCards(c.get("tenant"), fields)),
        ),
        201,
      ),
    )
    .get("/loads", requireRole(...COMPANY_READER_ROLES), (c) =>
      runEffect(runtime, c, listCardLoads(c.get("tenant"))),
    )
    .post("/confirmations", requireRole("admin", "employee"), (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, cardActionSchema).pipe(
          Effect.flatMap((action) =>
            startCardConfirmation(c.get("tenant"), action),
          ),
        ),
        201,
      ),
    )
    .post(
      "/confirmations/:challengeId",
      requireRole("admin", "employee"),
      (c) =>
        runEffect(
          runtime,
          c,
          idFrom(
            c.req.param("challengeId"),
            "That confirmation wasn't found. Start again.",
          ).pipe(
            Effect.flatMap((challengeId) =>
              readBody(c.req.raw, confirmSchema).pipe(
                Effect.flatMap(({ action, response }) =>
                  confirmCardAction(c.get("tenant"), {
                    challengeId,
                    action,
                    response,
                  }),
                ),
              ),
            ),
          ),
        ),
    )
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        readQuery(c.req.query(), listCardsQuerySchema).pipe(
          Effect.flatMap((filters) => listCards(c.get("tenant"), filters)),
        ),
      ),
    )
    .get("/:cardId", (c) =>
      runEffect(
        runtime,
        c,
        cardIdFrom(c.req.param("cardId")).pipe(
          Effect.flatMap((cardId) => getCard(c.get("tenant"), cardId)),
        ),
      ),
    )
    .post("/:cardId/freeze", requireRole("admin", "employee"), (c) =>
      runEffect(
        runtime,
        c,
        cardIdFrom(c.req.param("cardId")).pipe(
          Effect.flatMap((cardId) => freezeCard(c.get("tenant"), cardId)),
        ),
      ),
    )
    .post("/:cardId/close", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        cardIdFrom(c.req.param("cardId")).pipe(
          Effect.flatMap((cardId) => closeCard(c.get("tenant"), cardId)),
        ),
      ),
    )
    .post("/:cardId/lower-limit", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          cardIdFrom(c.req.param("cardId")),
          readBody(c.req.raw, lowerCardLimitRequestSchema),
        ]).pipe(
          Effect.flatMap(([cardId, { monthlyLimitUsd }]) =>
            lowerCardLimit(c.get("tenant"), cardId, monthlyLimitUsd),
          ),
        ),
      ),
    );
}
