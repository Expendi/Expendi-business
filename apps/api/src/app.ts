import { Hono } from "hono";
import { requestId } from "hono/request-id";

import type { AuthVariables } from "./middleware/auth.js";
import type { AppRuntime } from "./runtime.js";
import { internalErrorResponse } from "./http/respond.js";
import { authMiddleware } from "./middleware/auth.js";
import { createHealthRoutes } from "./routes/health.js";
import { createMeRoutes } from "./routes/me.js";
import { createOrganizationRoutes } from "./routes/organizations.js";

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

  const authenticate = authMiddleware(runtime);
  app.use("/me", authenticate);
  app.route("/me", createMeRoutes(runtime));

  app.use("/organizations/*", authenticate);
  app.route(
    "/organizations/:organizationId",
    createOrganizationRoutes(runtime),
  );

  return app;
}
