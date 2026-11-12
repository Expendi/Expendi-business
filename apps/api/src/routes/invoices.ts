import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  INVOICE_STATUSES,
  invoiceDraftInputSchema,
  invoiceMarkPaidSchema,
  invoiceMatchSchema,
  invoiceVoidSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader } from "../middleware/tenant.js";
import {
  createInvoiceDraft,
  deleteInvoiceDraft,
  getInvoice,
  listInvoices,
  markInvoicePaid,
  matchableDeposits,
  matchInvoiceDeposit,
  nextInvoiceNumber,
  remindInvoice,
  sendInvoice,
  undoInvoicePayment,
  updateInvoiceDraft,
  voidInvoice,
} from "../services/invoices/invoices.js";

const uuid = z.uuid();

const listQuerySchema = z.object({
  status: z.enum([...INVOICE_STATUSES, "overdue"]).optional(),
});

function idFrom(raw: string, what: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: `${what} not found.` }));
}

function parseStatus(
  query: Record<string, string>,
): Effect.Effect<z.infer<typeof listQuerySchema>["status"], BadRequest> {
  const parsed = listQuerySchema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data.status)
    : Effect.fail(
        new BadRequest({
          message: "Filter by draft, open, paid, void or overdue.",
        }),
      );
}

const invoiceIdFrom = (raw: string) => idFrom(raw, "Invoice");

/**
 * Mounted at `/organizations/:organizationId/invoices`. Admins write;
 * accountants read; employees see none.
 */
export function createInvoiceRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseStatus(c.req.query()).pipe(
          Effect.flatMap((status) => listInvoices(c.get("tenant"), status)),
        ),
      ),
    )
    .get("/next-number", (c) =>
      runEffect(runtime, c, nextInvoiceNumber(c.get("tenant"))),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, invoiceDraftInputSchema).pipe(
          Effect.flatMap((draft) => createInvoiceDraft(c.get("tenant"), draft)),
        ),
        201,
      ),
    )
    .get("/:invoiceId", (c) =>
      runEffect(
        runtime,
        c,
        invoiceIdFrom(c.req.param("invoiceId")).pipe(
          Effect.flatMap((invoiceId) => getInvoice(c.get("tenant"), invoiceId)),
        ),
      ),
    )
    .patch("/:invoiceId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          invoiceIdFrom(c.req.param("invoiceId")),
          readBody(c.req.raw, invoiceDraftInputSchema),
        ]).pipe(
          Effect.flatMap(([invoiceId, draft]) =>
            updateInvoiceDraft(c.get("tenant"), invoiceId, draft),
          ),
        ),
      ),
    )
    .delete("/:invoiceId", async (c) => {
      const response = await runEffect(
        runtime,
        c,
        invoiceIdFrom(c.req.param("invoiceId")).pipe(
          Effect.flatMap((invoiceId) =>
            deleteInvoiceDraft(c.get("tenant"), invoiceId),
          ),
          Effect.as(null),
        ),
      );
      return response.ok ? c.body(null, 204) : response;
    })
    .post("/:invoiceId/send", (c) =>
      runEffect(
        runtime,
        c,
        invoiceIdFrom(c.req.param("invoiceId")).pipe(
          Effect.flatMap((invoiceId) =>
            sendInvoice(c.get("tenant"), invoiceId),
          ),
        ),
      ),
    )
    .post("/:invoiceId/remind", (c) =>
      runEffect(
        runtime,
        c,
        invoiceIdFrom(c.req.param("invoiceId")).pipe(
          Effect.flatMap((invoiceId) =>
            remindInvoice(c.get("tenant"), invoiceId),
          ),
        ),
      ),
    )
    .post("/:invoiceId/void", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          invoiceIdFrom(c.req.param("invoiceId")),
          readBody(c.req.raw, invoiceVoidSchema),
        ]).pipe(
          Effect.flatMap(([invoiceId, { reason }]) =>
            voidInvoice(c.get("tenant"), invoiceId, reason),
          ),
        ),
      ),
    )
    .post("/:invoiceId/mark-paid", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          invoiceIdFrom(c.req.param("invoiceId")),
          readBody(c.req.raw, invoiceMarkPaidSchema),
        ]).pipe(
          Effect.flatMap(([invoiceId, input]) =>
            markInvoicePaid(c.get("tenant"), invoiceId, input),
          ),
        ),
      ),
    )
    .get("/:invoiceId/matchable-deposits", (c) =>
      runEffect(
        runtime,
        c,
        invoiceIdFrom(c.req.param("invoiceId")).pipe(
          Effect.flatMap((invoiceId) =>
            matchableDeposits(c.get("tenant"), invoiceId),
          ),
        ),
      ),
    )
    .post("/:invoiceId/match", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          invoiceIdFrom(c.req.param("invoiceId")),
          readBody(c.req.raw, invoiceMatchSchema),
        ]).pipe(
          Effect.flatMap(([invoiceId, { walletTransactionId }]) =>
            matchInvoiceDeposit(
              c.get("tenant"),
              invoiceId,
              walletTransactionId,
            ),
          ),
        ),
      ),
    )
    .delete("/:invoiceId/payments/:paymentId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          invoiceIdFrom(c.req.param("invoiceId")),
          idFrom(c.req.param("paymentId"), "Payment"),
        ]).pipe(
          Effect.flatMap(([invoiceId, paymentId]) =>
            undoInvoicePayment(c.get("tenant"), invoiceId, paymentId),
          ),
        ),
      ),
    );
}
