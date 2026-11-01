import type { RequestIdVariables } from "hono/request-id";
import { Effect, Exit } from "effect";
import { createMiddleware } from "hono/factory";

import type { AppRuntime } from "../runtime.js";
import { Unauthorized } from "../errors.js";
import { RequestMeta, requestMetaFrom } from "../http/request-meta.js";
import { clientErrorResponse, failureResponse } from "../http/respond.js";
import { authenticate } from "../services/auth/authenticate.js";

/**
 * Set by the authentication middleware: the caller's `users.id`, never a
 * provider ID.
 */
export interface AuthVariables extends RequestIdVariables {
  userId: string;
}

const BEARER = /^Bearer (\S+)$/;

const missingToken = new Unauthorized({ message: "Unauthorized" });

/**
 * Requires `Authorization: Bearer <Privy access token>`. A missing,
 * malformed, invalid or expired token gets 401.
 */
export function authMiddleware(runtime: AppRuntime) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return clientErrorResponse(c, missingToken);

    const exit = await runtime.runPromiseExit(
      authenticate(token).pipe(
        Effect.provideService(RequestMeta, requestMetaFrom(c)),
      ),
    );
    if (Exit.isFailure(exit)) return failureResponse(c, exit.cause);

    c.set("userId", exit.value.userId);
    await next();
  });
}
