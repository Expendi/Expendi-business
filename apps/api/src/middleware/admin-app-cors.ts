import { cors } from "hono/cors";

import type { AppRuntime } from "../runtime.js";
import { ConfigService } from "../config.js";

/**
 * The internal admin app calls `/internal/*` from the browser with a bearer
 * token. Only its origins (`ADMIN_APP_ORIGINS`) get CORS headers. Registered
 * before staff login, which would refuse a preflight (it carries no token)
 * and whose 401s and 403s the admin app must still be able to read.
 */
export function adminAppCors(runtime: AppRuntime) {
  return cors({
    origin: async (origin) => {
      const { adminAppOrigins } = await runtime.runPromise(ConfigService);
      return adminAppOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
}
