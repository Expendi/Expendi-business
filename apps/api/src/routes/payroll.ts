import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  addPayrollOneOffRequestSchema,
  adjustPayrollPaymentRequestSchema,
  changeSalaryAmountRequestSchema,
  createSalaryRequestSchema,
  leaveOutOfPayrollRequestSchema,
  passkeyAssertionSchema,
  PAYROLL_RUNS_LIST_MAX_SIZE,
  retryPaymentRequestSchema,
  SALARIES_LIST_MAX_SIZE,
  salaryAmountChangeSchema,
  updateSalaryRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import type { PayoutRejected } from "../services/payout/payout-errors.js";
import {
  BadRequest,
  Forbidden,
  NotFound,
  ServiceUnavailable,
} from "../errors.js";
import { readBody, readOptionalBody } from "../http/body.js";
import { payoutRejectionAsClientError } from "../http/payout-rejection.js";
import { runEffect } from "../http/respond.js";
import { requireAdminOrReader, requireRole } from "../middleware/tenant.js";
import { listMySalaryPayments } from "../services/payroll/my-payments.js";
import {
  confirmPayrollRunPayment,
  requestPayrollPaymentRetry,
  requestPayrollRunPayment,
} from "../services/payroll/pay.js";
import {
  addPayrollOneOff,
  adjustPayrollPayment,
  getPayrollRun,
  leaveOutOfPayroll,
  listPayrollRuns,
} from "../services/payroll/runs.js";
import {
  confirmSalaryAmountChange,
  createSalary,
  endSalary,
  getSalary,
  listSalaries,
  requestSalaryAmountChange,
  updateSalary,
} from "../services/payroll/salaries.js";

const uuid = z.uuid();

function idFrom(raw: string, missing: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: missing }));
}

const salaryIdFrom = (raw: string) => idFrom(raw, "That salary wasn't found.");
const runIdFrom = (raw: string) =>
  idFrom(raw, "That payroll run wasn't found.");
const billIdFrom = (raw: string) =>
  idFrom(raw, "That payment isn't in this payroll run.");

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

const paymentConfirmSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Your passkey's confirmation couldn't be read. Try again.",
  ),
});

const paymentNotFound = new NotFound({
  message: "That payment wasn't found. Start Approve & pay again.",
});

/** The active cash-out provider didn't answer while pricing a payment. */
const rateUnavailable = new ServiceUnavailable({
  message: "Couldn't get today's KES rate. Try again in a minute.",
});

/** Why the engine wouldn't prepare a payment, as the app shows it. */
const PREPARATION_FAILURES = {
  PayoutRejected: (error: PayoutRejected) =>
    Effect.fail(payoutRejectionAsClientError(error)),
  PaycrestError: () => Effect.fail(rateUnavailable),
  PretiumError: () => Effect.fail(rateUnavailable),
  AmountTooSmall: () =>
    Effect.fail(
      new BadRequest({
        message:
          "A payment in this run is below the smallest amount that can be sent.",
      }),
    ),
} as const;

/** Only the assertion's shape is checked here; the verifier checks its signature. */
const confirmSchema = z.object({
  change: salaryAmountChangeSchema,
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Confirm with your passkey.",
  ),
});

/**
 * Mounted at `/organizations/:organizationId/salaries`. Admins, and
 * accountants read-only: salaries are private (spec §4), and row-level
 * security hides them from every other role as well. A new net pay returns a passkey challenge,
 * confirmed at `/amount-changes/:challengeId/confirm`.
 */
export function createSalaryRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        listSalaries(c.get("tenant"), SALARIES_LIST_MAX_SIZE),
      ),
    )
    .get("/:salaryId", (c) =>
      runEffect(
        runtime,
        c,
        salaryIdFrom(c.req.param("salaryId")).pipe(
          Effect.flatMap((salaryId) => getSalary(c.get("tenant"), salaryId)),
        ),
      ),
    )
    .post("/", (c) =>
      runEffect(
        runtime,
        c,
        readBody(c.req.raw, createSalaryRequestSchema).pipe(
          Effect.flatMap((fields) => createSalary(c.get("tenant"), fields)),
        ),
        201,
      ),
    )
    .post("/amount-changes/:challengeId/confirm", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          challengeIdFrom(c.req.param("challengeId")),
          readBody(c.req.raw, confirmSchema),
        ]).pipe(
          Effect.flatMap(([challengeId, { change, response }]) =>
            confirmSalaryAmountChange(c.get("tenant"), {
              challengeId,
              change,
              response,
            }),
          ),
        ),
      ),
    )
    .patch("/:salaryId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          salaryIdFrom(c.req.param("salaryId")),
          readBody(c.req.raw, updateSalaryRequestSchema),
        ]).pipe(
          Effect.flatMap(([salaryId, changes]) =>
            updateSalary(c.get("tenant"), salaryId, changes),
          ),
        ),
      ),
    )
    .post("/:salaryId/amount", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          salaryIdFrom(c.req.param("salaryId")),
          readBody(c.req.raw, changeSalaryAmountRequestSchema),
        ]).pipe(
          Effect.flatMap(([salaryId, { amountKes }]) =>
            requestSalaryAmountChange(c.get("tenant"), salaryId, amountKes),
          ),
        ),
      ),
    )
    .post("/:salaryId/end", (c) =>
      runEffect(
        runtime,
        c,
        salaryIdFrom(c.req.param("salaryId")).pipe(
          Effect.flatMap((salaryId) => endSalary(c.get("tenant"), salaryId)),
        ),
      ),
    );
}

/**
 * Mounted at `/organizations/:organizationId/payroll-runs`. Admins, and
 * accountants read-only, like salaries. Drafts change only through these routes, each with a
 * reason. Approve & pay all and retrying one person are admin-only.
 */
export function createPayrollRunRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireAdminOrReader())
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        listPayrollRuns(c.get("tenant"), PAYROLL_RUNS_LIST_MAX_SIZE),
      ),
    )
    .get("/:runId", (c) =>
      runEffect(
        runtime,
        c,
        runIdFrom(c.req.param("runId")).pipe(
          Effect.flatMap((runId) => getPayrollRun(c.get("tenant"), runId)),
        ),
      ),
    )
    .post("/:runId/payment", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          runIdFrom(c.req.param("runId")),
          readOptionalBody(c.req.raw, retryPaymentRequestSchema),
        ]).pipe(
          Effect.flatMap(([runId, { secondConfirmation }]) =>
            requestPayrollRunPayment(c.get("tenant"), runId, {
              secondConfirmation,
            }),
          ),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      ),
    )
    .post("/:runId/payment/:challengeId/confirm", requireRole("admin"), (c) => {
      const challengeId = c.req.param("challengeId");
      return runEffect(
        runtime,
        c,
        Effect.all([
          runIdFrom(c.req.param("runId")),
          uuid.safeParse(challengeId).success
            ? Effect.succeed(challengeId)
            : Effect.fail(paymentNotFound),
          readBody(c.req.raw, paymentConfirmSchema),
        ]).pipe(
          Effect.flatMap(([runId, id, { response }]) =>
            confirmPayrollRunPayment(c.get("tenant"), runId, id, response),
          ),
          Effect.catchTag("PayoutRejected", (error) =>
            Effect.fail(payoutRejectionAsClientError(error)),
          ),
        ),
      );
    })
    .post("/:runId/payments/:billId/retry", requireRole("admin"), (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          runIdFrom(c.req.param("runId")),
          billIdFrom(c.req.param("billId")),
          readOptionalBody(c.req.raw, retryPaymentRequestSchema),
        ]).pipe(
          Effect.flatMap(([runId, billId, { secondConfirmation }]) =>
            requestPayrollPaymentRetry(c.get("tenant"), runId, billId, {
              secondConfirmation,
            }),
          ),
          Effect.catchTags(PREPARATION_FAILURES),
        ),
        201,
      ),
    )
    .post("/:runId/one-offs", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          runIdFrom(c.req.param("runId")),
          readBody(c.req.raw, addPayrollOneOffRequestSchema),
        ]).pipe(
          Effect.flatMap(([runId, fields]) =>
            addPayrollOneOff(c.get("tenant"), runId, fields),
          ),
        ),
        201,
      ),
    )
    .patch("/:runId/payments/:billId", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          runIdFrom(c.req.param("runId")),
          billIdFrom(c.req.param("billId")),
          readBody(c.req.raw, adjustPayrollPaymentRequestSchema),
        ]).pipe(
          Effect.flatMap(([runId, billId, fields]) =>
            adjustPayrollPayment(c.get("tenant"), runId, billId, fields),
          ),
        ),
      ),
    )
    .post("/:runId/payments/:billId/leave-out", (c) =>
      runEffect(
        runtime,
        c,
        Effect.all([
          runIdFrom(c.req.param("runId")),
          billIdFrom(c.req.param("billId")),
          readBody(c.req.raw, leaveOutOfPayrollRequestSchema),
        ]).pipe(
          Effect.flatMap(([runId, billId, { reason }]) =>
            leaveOutOfPayroll(c.get("tenant"), runId, billId, reason),
          ),
        ),
      ),
    );
}

/**
 * Mounted at `/organizations/:organizationId/me`: the caller's own things
 * in the company, for any role. Salary payments are only ever their own
 * (spec §4).
 */
export function createMyCompanyRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>().get(
    "/salary-payments",
    (c) => runEffect(runtime, c, listMySalaryPayments(c.get("tenant"))),
  );
}
