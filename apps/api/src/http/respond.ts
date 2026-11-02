import type { Context } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Cause, Effect, Exit, Option } from "effect";

import type { ClientError } from "../errors.js";
import type { AppDeps } from "../layers/main.js";
import type { AppRuntime } from "../runtime.js";
import { Conflict, isClientError } from "../errors.js";
import { RequestMeta, requestMetaFrom } from "./request-meta.js";

/**
 * `JSON.stringify` throws on BigInt. Money columns are bigint, so serialise
 * them as decimal strings, which JSON clients can read without losing
 * precision.
 */
export function jsonResponse(
  c: Context,
  body: unknown,
  status: ContentfulStatusCode,
): Response {
  return c.body(
    JSON.stringify(body, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    status,
    { "Content-Type": "application/json" },
  );
}

export function clientErrorResponse(c: Context, error: ClientError): Response {
  const details = error instanceof Conflict ? error.details : undefined;
  return jsonResponse(
    c,
    {
      success: false,
      error: {
        _tag: error._tag,
        message: error.message,
        ...(details && { details }),
      },
    },
    error.status,
  );
}

export function internalErrorResponse(c: Context): Response {
  return jsonResponse(
    c,
    {
      success: false,
      error: { _tag: "InternalError", message: "Internal server error" },
    },
    500,
  );
}

/**
 * Runs a route's effect and maps the outcome to the API envelope. Only
 * client errors expose their message; anything else is logged and becomes a
 * generic 500 so database or provider details never reach a caller.
 */
export async function runEffect<A, E, V extends RequestIdVariables>(
  runtime: AppRuntime,
  c: Context<{ Variables: V }>,
  effect: Effect.Effect<A, E, AppDeps | RequestMeta>,
  status: ContentfulStatusCode = 200,
): Promise<Response> {
  const exit = await runtime.runPromiseExit(
    Effect.provideService(effect, RequestMeta, requestMetaFrom(c)),
  );
  if (Exit.isSuccess(exit)) {
    return jsonResponse(c, { success: true, data: exit.value }, status);
  }
  return failureResponse(c, exit.cause);
}

/**
 * Client errors keep their status and message; anything else is logged and
 * becomes a generic 500.
 */
export function failureResponse<E, V extends RequestIdVariables>(
  c: Context<{ Variables: V }>,
  cause: Cause.Cause<E>,
): Response {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure) && isClientError(failure.value)) {
    return clientErrorResponse(c, failure.value);
  }
  console.error(
    `[http] request ${c.get("requestId")} failed`,
    Cause.pretty(cause),
  );
  return internalErrorResponse(c);
}
