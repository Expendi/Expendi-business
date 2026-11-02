import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  attachBillFilesRequestSchema,
  billUploadRequestSchema,
  cancelBillRequestSchema,
  createBillRequestSchema,
  listBillsQuerySchema,
  markBillPaidOutsideRequestSchema,
  updateBillRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  attachBillInvoices,
  cancelBill,
  createBill,
  getBill,
  listBills,
  markBillPaidOutside,
  updateBill,
} from "../services/bills/bills.js";
import { requestBillFileUpload } from "../services/bills/files.js";

const uuid = z.uuid();

function billIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "That bill wasn't found." }));
}

function parseQuery(
  query: Record<string, string>,
): Effect.Effect<z.output<typeof listBillsQuerySchema>, BadRequest> {
  const parsed = listBillsQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid filters",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/bills`. Admins only (spec §4);
 * row-level security hides bills from every other role as well.
 */
export function createBillRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(c.req.query()).pipe(
          Effect.flatMap((filters) => listBills(c.get("tenant"), filters)),
        ),
      ),
    )
    .post("/upload-url", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, billUploadRequestSchema).pipe(
          Effect.flatMap((upload) =>
            requestBillFileUpload(c.get("tenant"), upload),
          ),
        ),
        201,
      ),
    )
    .get("/:billId", (c) =>
      runEffect(
        runtime,
        c,
        billIdFrom(c.req.param("billId")).pipe(
          Effect.flatMap((billId) => getBill(c.get("tenant"), billId)),
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, createBillRequestSchema).pipe(
          Effect.flatMap((fields) => createBill(c.get("tenant"), fields)),
        ),
        201,
      ),
    )
    .patch("/:billId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          billIdFrom(c.req.param("billId")),
          readBody(c.req.raw, updateBillRequestSchema),
        ]).pipe(
          Effect.flatMap(([billId, changes]) =>
            updateBill(c.get("tenant"), billId, changes),
          ),
        ),
      ),
    )
    .post("/:billId/attachments", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          billIdFrom(c.req.param("billId")),
          readBody(c.req.raw, attachBillFilesRequestSchema),
        ]).pipe(
          Effect.flatMap(([billId, { receiptFileIds }]) =>
            attachBillInvoices(c.get("tenant"), billId, receiptFileIds),
          ),
        ),
      ),
    )
    .post("/:billId/mark-paid-outside", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          billIdFrom(c.req.param("billId")),
          readBody(c.req.raw, markBillPaidOutsideRequestSchema),
        ]).pipe(
          Effect.flatMap(([billId, fields]) =>
            markBillPaidOutside(c.get("tenant"), billId, fields),
          ),
        ),
      ),
    )
    .post("/:billId/cancel", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          billIdFrom(c.req.param("billId")),
          readBody(c.req.raw, cancelBillRequestSchema),
        ]).pipe(
          Effect.flatMap(([billId, { reason }]) =>
            cancelBill(c.get("tenant"), billId, reason),
          ),
        ),
      ),
    );
}
