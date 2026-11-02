import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Hono } from "hono";

import type { OrganizationResponse } from "@expendi-business/shared";
import { createOrganizationRequestSchema } from "@expendi-business/shared";

import type { AuthVariables } from "../middleware/auth.js";
import type { TenantVariables } from "../middleware/tenant.js";
import type { AppRuntime } from "../runtime.js";
import { organizations } from "../db/schema/index.js";
import { query, withScope } from "../db/scope.js";
import { NotFound } from "../errors.js";
import { readBody } from "../http/body.js";
import { runEffect } from "../http/respond.js";
import { tenantMiddleware } from "../middleware/tenant.js";
import { signUpCompany } from "../services/organization/create-organization.js";
import { createActivityRoutes } from "./activity.js";
import { createAllowlistRoutes } from "./allowlist.js";
import { createBillRoutes } from "./bills.js";
import { createCategoryRoutes } from "./categories.js";
import { createClaimRoutes } from "./claims.js";
import { createExpenseRoutes } from "./expenses.js";
import { createFloatRoutes } from "./floats.js";
import { createMemberRoutes } from "./members.js";
import { createOverviewRoutes } from "./overview.js";
import { createPaidFromAccountRoutes } from "./paid-from-accounts.js";
import { createPayeeRoutes } from "./payees.js";
import {
  createMyCompanyRoutes,
  createPayrollRunRoutes,
  createSalaryRoutes,
} from "./payroll.js";
import { createReceiptRoutes } from "./receipts.js";
import { createRecurringItemRoutes } from "./recurring-items.js";
import { createReportRoutes } from "./reports.js";
import { createSettingsRoutes } from "./settings.js";
import { createCompanySpendingRoutes } from "./spending.js";
import { createWalletRoutes } from "./wallet.js";
import { createWithdrawalRoutes } from "./withdrawals.js";

/**
 * Mounted at `/organizations`, for a signed-in user who may not belong to
 * any company yet (spec §6.1).
 */
export function createSignUpRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: AuthVariables }> {
  return new Hono<{ Variables: AuthVariables }>().post("/", (c) => {
    const userId = c.get("userId");
    return runEffect(
      runtime,
      c,
      readBody(c.req.raw, createOrganizationRequestSchema).pipe(
        Effect.flatMap(({ name, kraPin }) =>
          signUpCompany({ userId, name, kraPin }),
        ),
      ),
      201,
    );
  });
}

/** Mounted at `/organizations/:organizationId`. */
export function createOrganizationRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: TenantVariables }> {
  return new Hono<{ Variables: TenantVariables }>()
    .use(tenantMiddleware(runtime))
    .get("/", (c) => {
      const tenant = c.get("tenant");
      return runEffect(
        runtime,
        c,
        withScope(tenant, (tx) =>
          query(() =>
            tx
              .select({
                id: organizations.id,
                name: organizations.name,
                kraPin: organizations.kraPin,
              })
              .from(organizations)
              .where(eq(organizations.id, tenant.organizationId))
              .limit(1),
          ),
        ).pipe(
          Effect.flatMap(([organization]) =>
            organization
              ? Effect.succeed({
                  ...organization,
                  role: tenant.role,
                } satisfies OrganizationResponse)
              : Effect.fail(new NotFound({ message: "Company not found" })),
          ),
        ),
      );
    })
    .route("/activity", createActivityRoutes(runtime))
    .route("/bills", createBillRoutes(runtime))
    .route("/categories", createCategoryRoutes(runtime))
    .route("/claims", createClaimRoutes(runtime))
    .route("/company-spending", createCompanySpendingRoutes(runtime))
    .route("/expenses", createExpenseRoutes(runtime))
    .route("/floats", createFloatRoutes(runtime))
    .route("/members", createMemberRoutes(runtime))
    .route("/me", createMyCompanyRoutes(runtime))
    .route("/overview", createOverviewRoutes(runtime))
    .route("/paid-from-accounts", createPaidFromAccountRoutes(runtime))
    .route("/payees", createPayeeRoutes(runtime))
    .route("/payroll-runs", createPayrollRunRoutes(runtime))
    .route("/receipts", createReceiptRoutes(runtime))
    .route("/recurring-items", createRecurringItemRoutes(runtime))
    .route("/reports", createReportRoutes(runtime))
    .route("/salaries", createSalaryRoutes(runtime))
    .route("/settings", createSettingsRoutes(runtime))
    .route("/wallet", createWalletRoutes(runtime))
    .route("/withdrawal-addresses", createAllowlistRoutes(runtime))
    .route("/withdrawals", createWithdrawalRoutes(runtime));
}
