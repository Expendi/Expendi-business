import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  attachCardReceiptRequestSchema,
  listCardPurchasesQuerySchema,
  reviewCardPurchaseRequestSchema,
  waiveCardReceiptRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  attachCardReceipts,
  getCardPurchase,
  listCardPurchases,
  waiveCardReceipt,
} from "../services/cards/purchases.js";
import { reviewCardPurchase } from "../services/cards/review.js";

const purchaseIdSchema = z.uuid();

function purchaseIdFrom(raw: string): Effect.Effect<string, NotFound> {
  const parsed = purchaseIdSchema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new NotFound({ message: "That purchase wasn't found." }));
}

function readListQuery(
  query: Record<string, string>,
): Effect.Effect<z.output<typeof listCardPurchasesQuerySchema>, BadRequest> {
  const parsed = listCardPurchasesQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid query",
        }),
      );
}

/** Mounted at `/organizations/:organizationId/cards/purchases` (spec §6.25). */
export function createCardPurchaseRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        readListQuery(c.req.query()).pipe(
          Effect.flatMap((query) => listCardPurchases(c.get("tenant"), query)),
        ),
      ),
    )
    .get("/:purchaseId", (c) =>
      runEffect(
        runtime,
        c,
        purchaseIdFrom(c.req.param("purchaseId")).pipe(
          Effect.flatMap((purchaseId) =>
            getCardPurchase(c.get("tenant"), purchaseId),
          ),
        ),
      ),
    )
    .post("/:purchaseId/receipts", (c) =>
      runEffect(
        runtime,
        c,
        Effect.gen(function* () {
          const purchaseId = yield* purchaseIdFrom(c.req.param("purchaseId"));
          const fields = yield* readBody(
            c.req.raw,
            attachCardReceiptRequestSchema,
          );
          return yield* attachCardReceipts(c.get("tenant"), purchaseId, fields);
        }),
      ),
    )
    .post("/:purchaseId/no-receipt", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.gen(function* () {
          const purchaseId = yield* purchaseIdFrom(c.req.param("purchaseId"));
          const fields = yield* readBody(
            c.req.raw,
            waiveCardReceiptRequestSchema,
          );
          return yield* waiveCardReceipt(c.get("tenant"), purchaseId, fields);
        }),
      ),
    )
    .post("/:purchaseId/review", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.gen(function* () {
          const purchaseId = yield* purchaseIdFrom(c.req.param("purchaseId"));
          const review = yield* readBody(
            c.req.raw,
            reviewCardPurchaseRequestSchema,
          );
          return yield* reviewCardPurchase(c.get("tenant"), purchaseId, review);
        }),
      ),
    );
}
