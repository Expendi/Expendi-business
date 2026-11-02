import type { z } from "zod";
import { Effect } from "effect";

import { BadRequest } from "../errors.js";

/**
 * Reads and validates a JSON body. The first problem's message goes back to
 * the caller, so the shared schemas word theirs for the person using the app.
 */
export function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Effect.Effect<T, BadRequest> {
  return Effect.tryPromise({
    try: (): Promise<unknown> => request.json(),
    catch: () => new BadRequest({ message: "Invalid JSON" }),
  }).pipe(Effect.flatMap((body) => validate(body, schema)));
}

/**
 * Like `readBody`, but an empty body counts as `{}`, for actions whose
 * fields are all optional, e.g. a retry.
 */
export function readOptionalBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Effect.Effect<T, BadRequest> {
  return Effect.tryPromise({
    try: async (): Promise<unknown> => {
      const text = await request.text();
      return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    },
    catch: () => new BadRequest({ message: "Invalid JSON" }),
  }).pipe(Effect.flatMap((body) => validate(body, schema)));
}

function validate<T>(
  body: unknown,
  schema: z.ZodType<T>,
): Effect.Effect<T, BadRequest> {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid request body",
        }),
      );
}
