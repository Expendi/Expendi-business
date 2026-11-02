import { z } from "zod";

import type { DuplicateOf } from "@expendi-business/shared";
import { duplicateOfSchema } from "@expendi-business/shared";

import { ApiError } from "../../lib/api";

const duplicateDetailsSchema = z.object({ duplicateOf: duplicateOfSchema });

/** The earlier record a refused duplicate matches, when the API named it (spec §6.5). */
export function duplicateOfError(error: unknown): DuplicateOf | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = duplicateDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data.duplicateOf : null;
}
