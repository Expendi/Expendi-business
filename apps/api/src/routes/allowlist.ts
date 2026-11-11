import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { payeeChainSchema } from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import type { AllowlistChange } from "../services/allowlist/allowlist.js";
import { BadRequest } from "../errors.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  confirmAllowlistChange,
  listAllowlist,
  requestAllowlistChange,
} from "../services/allowlist/allowlist.js";

const changeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    chain: payeeChainSchema,
    address: z.string(),
    label: z.string(),
  }),
  z.object({ action: z.literal("remove"), addressId: z.uuid() }),
]);

/**
 * The WebAuthn assertion as the browser or app returns it; its fields are
 * checked cryptographically by the verifier, so only the shape is checked.
 */
const assertionSchema = z.looseObject({
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

const confirmSchema = z.object({
  change: changeSchema,
  response: z.custom<AuthenticationResponseJSON>(
    (value) => assertionSchema.safeParse(value).success,
  ),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new BadRequest({ message: "Invalid request body" }));
}

const readJson = (request: Request) =>
  Effect.tryPromise({
    try: (): Promise<unknown> => request.json(),
    catch: () => new BadRequest({ message: "Invalid JSON" }),
  });

/**
 * Mounted at `/organizations/:organizationId/withdrawal-addresses`. Admins,
 * and accountants read-only (spec §4); every change needs the admin's
 * passkey (spec §7).
 */
export function createAllowlistRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(runtime, c, listAllowlist(c.get("tenant").organizationId)),
    )
    .post("/changes", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readJson(c.req.raw).pipe(
          Effect.flatMap((body) => parseBody(changeSchema, body)),
          Effect.flatMap((change: AllowlistChange) =>
            requestAllowlistChange({
              organizationId: tenant.organizationId,
              userId: tenant.userId,
              change,
            }),
          ),
        ),
      );
    })
    .post("/changes/:challengeId/confirm", (c) => {
      const tenant = c.get("tenant");
      const challengeId = c.req.param("challengeId");
      return runEffect(
        runtime,
        c,
        readJson(c.req.raw).pipe(
          Effect.flatMap((body) => parseBody(confirmSchema, body)),
          Effect.flatMap(({ change, response }) =>
            confirmAllowlistChange({
              organizationId: tenant.organizationId,
              userId: tenant.userId,
              challengeId,
              change,
              response,
            }),
          ),
        ),
      );
    });
}
