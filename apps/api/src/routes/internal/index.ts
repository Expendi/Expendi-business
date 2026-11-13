import { Hono } from "hono";

import type { StaffVariables } from "../../middleware/staff-auth.js";
import type { AppRuntime } from "../../runtime.js";
import { adminAppCors } from "../../middleware/admin-app-cors.js";
import { staffAuthMiddleware } from "../../middleware/staff-auth.js";
import { createZohoStaffRoutes } from "./accounting.js";
import { createAlertRoutes } from "./alerts.js";
import { createAuditRoutes } from "./audit.js";
import { createStaffAuthRoutes } from "./auth.js";
import { createCardSimulationRoutes } from "./card-simulations.js";
import { createCompanyRoutes } from "./companies.js";
import { createControlRoutes } from "./controls.js";
import { createImportRoutes } from "./imports.js";
import { createIntentQuoteRoutes } from "./intent-quotes.js";
import { createPayoutRoutes } from "./payouts.js";
import { createTreasuryActionRoutes } from "./treasury-actions.js";

/**
 * Mounted at `/internal`: the Expendi team's admin app (spec §6.15). Every
 * route is behind staff login, and every action also needs
 * `requireStaffRole("ops_admin")`.
 *
 * Staff never move a company's money: no route here may create, approve or
 * fund a payout or withdrawal. `internal-routes.test.ts` checks every route
 * registered under `/internal` for both rules.
 */
export function createInternalRoutes(
  runtime: AppRuntime,
): Hono<{ Variables: StaffVariables }> {
  return new Hono<{ Variables: StaffVariables }>()
    .use(adminAppCors(runtime))
    .use(staffAuthMiddleware(runtime))
    .route("/", createStaffAuthRoutes(runtime))
    .route("/", createAuditRoutes(runtime))
    .route("/", createAlertRoutes(runtime))
    .route("/companies/:organizationId/zoho", createZohoStaffRoutes(runtime))
    .route("/", createCompanyRoutes(runtime))
    .route("/", createImportRoutes(runtime))
    .route("/", createPayoutRoutes(runtime))
    .route("/", createIntentQuoteRoutes(runtime))
    .route("/", createControlRoutes(runtime))
    .route("/", createTreasuryActionRoutes(runtime))
    .route("/", createCardSimulationRoutes(runtime));
}
