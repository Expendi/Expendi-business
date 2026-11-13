import type { RequestIdVariables } from "hono/request-id";
import { Effect, Exit } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import { invoicePayQuoteRequestSchema } from "@expendi-business/shared";

import type { AppRuntime } from "../runtime.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { failureResponse, runEffect } from "../http/respond.js";
import {
  getInvoicePdfData,
  invoicePdfFilename,
  renderInvoicePdf,
} from "../services/invoices/invoice-pdf.js";
import {
  getPayQuote,
  getPublicInvoice,
  quoteForPayment,
} from "../services/invoices/pay-link.js";

/**
 * `/pay/:publicId` (docs/decisions/crypto-invoicing.md, "The pay link").
 * Public: the invoice's public ID is the whole credential, so these routes
 * take no login and show only what the customer's page needs.
 */
export function createPayRoutes(runtime: AppRuntime) {
  return new Hono<{ Variables: RequestIdVariables }>()
    .get("/:publicId/pdf", async (c) => {
      c.header("Cache-Control", "no-store");
      const exit = await runtime.runPromiseExit(
        getInvoicePdfData(c.req.param("publicId")).pipe(
          Effect.flatMap((data) =>
            Effect.promise(() => renderInvoicePdf(data)).pipe(
              Effect.map((bytes) => ({ bytes, number: data.invoice.number })),
            ),
          ),
        ),
      );
      if (Exit.isFailure(exit)) return failureResponse(c, exit.cause);
      const { bytes, number } = exit.value;
      return c.body(new Uint8Array(bytes), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoicePdfFilename(number)}"`,
        "X-Content-Type-Options": "nosniff",
      });
    })
    .get("/:publicId", (c) =>
      runEffect(runtime, c, getPublicInvoice(c.req.param("publicId"))),
    )
    .post("/:publicId/quotes", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, invoicePayQuoteRequestSchema).pipe(
          Effect.flatMap((body) =>
            quoteForPayment(c.req.param("publicId"), body.chain),
          ),
        ),
        201,
      ),
    )
    .get("/:publicId/quotes/:quoteId", (c) => {
      const quoteId = c.req.param("quoteId");
      return runEffect(
        runtime,
        c,
        z.uuid().safeParse(quoteId).success
          ? getPayQuote(c.req.param("publicId"), quoteId)
          : Effect.fail(new NotFound({ message: "Quote not found." })),
      );
    });
}
