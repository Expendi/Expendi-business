import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import type { ReceiptSmsResponse } from "@expendi-business/shared";
import {
  receiptSmsRequestSchema,
  receiptUploadRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { extractReceipt } from "../services/expenses/extraction.js";
import {
  registerSmsReceipt,
  requestReceiptUpload,
} from "../services/expenses/receipts.js";

const receiptFileIdSchema = z.uuid();

function receiptFileIdFrom(raw: string): Effect.Effect<string, NotFound> {
  const parsed = receiptFileIdSchema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(new NotFound({ message: "Receipt not found" }));
}

/**
 * Mounted at `/organizations/:organizationId/receipts`. Any member who can
 * record spending uploads receipts straight to storage, or pastes an M-Pesa
 * SMS, and has their own uploads read to pre-fill the form (spec §6.3, §6.4).
 */
export function createReceiptRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .post("/upload-url", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, receiptUploadRequestSchema).pipe(
          Effect.flatMap((upload) => requestReceiptUpload(tenant, upload)),
        ),
        201,
      );
    })
    .post("/sms", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        readBody(c.req.raw, receiptSmsRequestSchema).pipe(
          Effect.flatMap(({ text }) => registerSmsReceipt(tenant, text)),
          Effect.map(({ receiptFileId, sms }): ReceiptSmsResponse => ({
            receiptFileId,
            sms: {
              kind: sms.kind,
              code: sms.code,
              amountKesCents: sms.amountKesCents,
              counterparty: sms.counterparty,
              occurredAt: sms.occurredAt,
            },
          })),
        ),
        201,
      );
    })
    .post("/:receiptFileId/extract", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        receiptFileIdFrom(c.req.param("receiptFileId")).pipe(
          Effect.flatMap((receiptFileId) =>
            extractReceipt(tenant, receiptFileId),
          ),
        ),
      );
    });
}
