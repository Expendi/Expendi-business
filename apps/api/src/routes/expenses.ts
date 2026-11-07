import { Effect } from "effect";
import { Hono } from "hono";
import { z } from "zod";

import {
  COMPANY_READER_ROLES,
  expenseListQuerySchema,
  expenseSummaryQuerySchema,
} from "@expendi-business/shared";

import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { BadRequest, NotFound } from "../errors.js";
import { runEffect } from "../http/respond.js";
import { requireRole } from "../middleware/tenant.js";
import {
  expensesSummary,
  getExpense,
  listExpenses,
} from "../services/expenses/all-expenses.js";

const uuid = z.uuid();

function expenseIdFrom(raw: string): Effect.Effect<string, NotFound> {
  return uuid.safeParse(raw).success
    ? Effect.succeed(raw)
    : Effect.fail(new NotFound({ message: "Expense not found" }));
}

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
 * Mounted at `/organizations/:organizationId/expenses`: every claim, petty
 * cash purchase and company spending record, read-only, for the web
 * dashboard (spec §6.14), and `/summary`, their totals. Admins and
 * accountants only; employees see their own claims and floats through
 * those routes.
 */
export function createExpenseRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole(...COMPANY_READER_ROLES))
    .get("/", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(expenseListQuerySchema, c.req.query()).pipe(
          Effect.flatMap((filters) => listExpenses(c.get("tenant"), filters)),
        ),
      ),
    )
    .get("/summary", (c) =>
      runEffect(
        runtime,
        c,
        parseQuery(expenseSummaryQuerySchema, c.req.query()).pipe(
          Effect.flatMap((filters) =>
            expensesSummary(c.get("tenant"), filters),
          ),
        ),
      ),
    )
    .get("/:expenseId", (c) =>
      runEffect(
        runtime,
        c,
        expenseIdFrom(c.req.param("expenseId")).pipe(
          Effect.flatMap((expenseId) => getExpense(c.get("tenant"), expenseId)),
        ),
      ),
    );
}
