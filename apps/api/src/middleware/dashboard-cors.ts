import { cors } from "hono/cors";

import type { AppRuntime } from "../runtime.js";
import { ConfigService } from "../config.js";

/**
 * The company web dashboard (spec §6.14) calls the customer routes (`/me/*`,
 * `/organizations/*`) from the browser with a bearer token. Only its origins
 * (`DASHBOARD_ORIGINS`) get CORS headers; every role rule stays in the
 * routes. Registered before customer login, which would refuse a preflight
 * (it carries no token) and whose 401s and 403s the dashboard must still be
 * able to read.
 */
export function dashboardCors(runtime: AppRuntime) {
  return cors({
    origin: async (origin) => {
      const { dashboardOrigins } = await runtime.runPromise(ConfigService);
      return dashboardOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
}
