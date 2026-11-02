import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  createPaidFromAccountRequestSchema,
  listPaidFromAccountsQuerySchema,
  updatePaidFromAccountRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  archivePaidFromAccount,
  createPaidFromAccount,
  listPaidFromAccounts,
  updatePaidFromAccount,
} from "../services/expenses/paid-from-accounts.js";

const uuid = z.uuid();

function accountIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "That account wasn't found." }));
}

function parseQuery(
  query: Record<string, string>,
): Effect.Effect<z.output<typeof listPaidFromAccountsQuerySchema>, BadRequest> {
  const parsed = listPaidFromAccountsQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid filters",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/paid-from-accounts`: the
 * company's list of accounts it pays from outside Expendi (spec §6.23).
 * Admins only.
 */
export function createPaidFromAccountRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(c.req.query()).pipe(
          Effect.flatMap((filters) =>
            listPaidFromAccounts(c.get("tenant"), filters),
          ),
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, createPaidFromAccountRequestSchema).pipe(
          Effect.flatMap((fields) =>
            createPaidFromAccount(c.get("tenant"), fields),
          ),
        ),
        201,
      ),
    )
    .patch("/:accountId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          accountIdFrom(c.req.param("accountId")),
          readBody(c.req.raw, updatePaidFromAccountRequestSchema),
        ]).pipe(
          Effect.flatMap(([accountId, changes]) =>
            updatePaidFromAccount(c.get("tenant"), accountId, changes),
          ),
        ),
      ),
    )
    .post("/:accountId/archive", (c) =>
      runEffect(
        runtime,
        c,
        accountIdFrom(c.req.param("accountId")).pipe(
          Effect.flatMap((accountId) =>
            archivePaidFromAccount(c.get("tenant"), accountId),
          ),
        ),
      ),
    );
}
