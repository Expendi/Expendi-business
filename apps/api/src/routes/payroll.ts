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
  SALARIES_LIST_MAX_SIZE,
  salaryAmountChangeSchema,
  updateSalaryRequestSchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { Forbidden, NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import { listMySalaryPayments } from "../services/payroll/my-payments.js";
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

/** Only the assertion's shape is checked here; the verifier checks its signature. */
const confirmSchema = z.object({
  change: salaryAmountChangeSchema,
  response: z.custom<AuthenticationResponseJSON>(
    (value) => passkeyAssertionSchema.safeParse(value).success,
    "Confirm with your passkey.",
  ),
});

/**
 * Mounted at `/organizations/:organizationId/salaries`. Admins only:
 * salaries are private (spec §4), and row-level security hides them from
 * every other role as well. A new net pay returns a passkey challenge,
 * confirmed at `/amount-changes/:challengeId/confirm`.
 */
export function createSalaryRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
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
 * Mounted at `/organizations/:organizationId/payroll-runs`. Admins only,
 * like salaries. Drafts change only through these routes, each with a
 * reason; paying a run is T39.
 */
export function createPayrollRunRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("admin"))
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
