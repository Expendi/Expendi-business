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
  }).pipe(
    Effect.flatMap((body) => {
      const parsed = schema.safeParse(body);
      return parsed.success
        ? Effect.succeed(parsed.data)
        : Effect.fail(
            new BadRequest({
              message:
                parsed.error.issues[0]?.message ?? "Invalid request body",
            }),
          );
    }),
  );
}
