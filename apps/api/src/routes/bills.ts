import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  attachBillFilesRequestSchema,
  billsSummaryQuerySchema,
  billUploadRequestSchema,
  cancelBillRequestSchema,
  createBillRequestSchema,
  listBillsQuerySchema,
  markBillPaidOutsideRequestSchema,
  passkeyAssertionSchema,
  payBillsRequestSchema,
  retryPaymentRequestSchema,
  updateBillRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import type { PayoutRejected } from "../services/payout/payout-errors.js";
import { BadRequest, NotFound, ServiceUnavailable } from "../errors.js";
import { readBody, readOptionalBody } from "../http/body.js";
import { payoutRejectionAsClientError } from "../http/payout-rejection.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader, requireRole } from "../middleware/tenant.js";
import {
  attachBillInvoices,
  billsSummary,
  cancelBill,
  createBill,
  getBill,
  listBills,
  markBillPaidOutside,
  updateBill,
} from "../services/bills/bills.js";
import { requestBillFileUpload } from "../services/bills/files.js";
import {
  confirmBillPayment,
  requestBillPayment,
  requestBillRetry,
} from "../services/bills/pay.js";

const uuid = z.uuid();

function billIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "That bill wasn't found." }));
}

const paymentNotFound = new NotFound({
  message: "That payment wasn't found. Start paying again.",
});

const confirmSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

/** Why the engine wouldn't prepare a payment, as the app shows it. */
const PREPARATION_FAILURES = {
  PayoutRejected: (error: PayoutRejected) =>
    Effect.fail(payoutRejectionAsClientError(error)),
  PaycrestError: () =>
    Effect.fail(
      new ServiceUnavailable({
        message:
          "Couldn't get today's KES rate from Paycrest. Try again in a minute.",
      }),
    ),
  AmountTooSmall: () =>
    Effect.fail(
      new BadRequest({
        message: "This bill is below the smallest amount Paycrest pays.",
      }),
    ),
} as const;

function parseQuery<Schema extends z.ZodType>(
  schema: Schema,
  query: Record<string, string>,
): Effect.Effect<z.output<Schema>, BadRequest> {
  const parsed = schema.safeParse(query);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid filters",
        }),
      );
}

/**
 * Mounted at `/organizations/:organizationId/bills`. Admins, and accountants
 * read-only (spec §4); row-level security hides bills from every other role
 * as well.
 */
export function createBillRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(listBillsQuerySchema, c.req.query()).pipe(
          Effect.flatMap((filters) => listBills(c.get("tenant"), filters)),
        ),
      ),
    )
    .get("/summary", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(billsSummaryQuerySchema, c.req.query()).pipe(
          Effect.flatMap((filters) => billsSummary(c.get("tenant"), filters)),
        ),
      ),
    )
    .post("/payment", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, payBillsRequestSchema).pipe(
          Effect.flatMap(({ billIds, secondConfirmation }) =>
            requestBillPayment(c.get("tenant"), billIds, {
              secondConfirmation,
            }),
          ),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      ),
    )
    .post("/payment/:challengeId/confirm", requireRole("admin"), (c) => {
      const challengeId = c.req.param("challengeId");
      return runEffect(
        runtime,
        c,
        (uuid.safeParse(challengeId).success
          ? Effect.void
          : Effect.fail(paymentNotFound)
        ).pipe(
          Effect.zipRight(readBody(c.req.raw, confirmSchema)),
          Effect.flatMap(({ response }) =>
            confirmBillPayment(c.get("tenant"), challengeId, response),
          ),
          Effect.catchTag("PayoutRejected", (error) =>
            Effect.fail(payoutRejectionAsClientError(error)),
          ),
        ),
      );
    })
    .post("/:billId/retry", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          billIdFrom(c.req.param("billId")),
          readOptionalBody(c.req.raw, retryPaymentRequestSchema),
        ]).pipe(
          Effect.flatMap(([billId, { secondConfirmation }]) =>
            requestBillRetry(c.get("tenant"), billId, { secondConfirmation }),
          ),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
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
