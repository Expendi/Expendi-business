import { Hono } from "hono";
import { requestId } from "hono/request-id";

import type { AuthVariables } from "./middleware/auth.js";
import type { AppRuntime } from "./runtime.js";
import { internalErrorResponse } from "./http/respond.js";
import { authMiddleware } from "./middleware/auth.js";
import { dashboardCors } from "./middleware/dashboard-cors.js";
import { createAlchemyWebhookRoutes } from "./routes/alchemy-webhooks.js";
import { createApprovalPasskeyRoutes } from "./routes/approval-passkey.js";
import { createHealthRoutes } from "./routes/health.js";
import { createZohoIntegrationRoutes } from "./routes/integrations/zoho.js";
import { createInternalRoutes } from "./routes/internal/index.js";
import { createLithicWebhookRoutes } from "./routes/lithic-webhook.js";
import { createMeRoutes } from "./routes/me.js";
import {
  createOrganizationRoutes,
  createSignUpRoutes,
} from "./routes/organizations.js";
import { createPaycrestWebhookRoutes } from "./routes/paycrest-webhook.js";
import { createReportDownloadRoutes } from "./routes/reports.js";

export type App = Hono<{ Variables: AuthVariables }>;

export function createApp({ runtime }: { readonly runtime: AppRuntime }): App {
  const app: App = new Hono();

  // Echoes a well-formed incoming X-Request-Id or generates one, on every
  // response; audit entries store the same value.
  app.use("*", requestId());
  app.onError((error, c) => {
    console.error(`[http] request ${c.get("requestId")} threw`, error);
    return internalErrorResponse(c);
  });

  app.route("/health", createHealthRoutes());
  app.route("/downloads/reports", createReportDownloadRoutes(runtime));
  // Signed by the provider, not a user, so no login middleware.
  app.route("/webhooks", createAlchemyWebhookRoutes(runtime));
  app.route("/webhooks", createPaycrestWebhookRoutes(runtime));
  app.route("/webhooks", createLithicWebhookRoutes(runtime));
  // Opened by a company's accountant, who has no Expendi login: the connect
  // link's token and Zoho's signed state authorize each step.
  app.route("/integrations/zoho", createZohoIntegrationRoutes(runtime));

  const authenticate = authMiddleware(runtime);
  // Browser CORS for the web dashboard on customer routes only, ahead of
  // login so preflights and refusals reach the dashboard.
  const customerCors = dashboardCors(runtime);
  // Also matches `/me` itself.
  app.use("/me/*", customerCors, authenticate);
  app.route("/me", createMeRoutes(runtime));
  app.route("/me/approval-passkey", createApprovalPasskeyRoutes(runtime));

  // Also matches `/organizations` itself, so sign-up is authenticated too.
  app.use("/organizations/*", customerCors, authenticate);
  app.route("/organizations", createSignUpRoutes(runtime));
  app.route(
    "/organizations/:organizationId",
    createOrganizationRoutes(runtime),
  );

  // Staff login, separate from customer login (spec §6.15).
  app.route("/internal", createInternalRoutes(runtime));

  return app;
}
