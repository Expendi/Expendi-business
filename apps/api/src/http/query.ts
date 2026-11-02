import type { z } from "zod";
import { Effect } from "effect";

import { BadRequest } from "../errors.js";

/**
 * Validates a request's query string, like `readBody` does a JSON body: the
 * first problem's message goes back to the caller.
 */
export function readQuery<T>(
  raw: Record<string, string>,
  schema: z.ZodType<T>,
): Effect.Effect<T, BadRequest> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new BadRequest({
          message: parsed.error.issues[0]?.message ?? "Invalid search",
        }),
      );
}
