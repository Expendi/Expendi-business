import { z } from "zod";

import { membershipRoleSchema, membershipStatusSchema } from "./membership.js";

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    /** Verified M-Pesa payout number; null until confirmed by SMS code. */
    phone: z.string().nullable(),
    fullName: z.string().nullable(),
  }),
  memberships: z.array(
    z.object({
      id: z.uuid(),
      organizationId: z.uuid(),
      organizationName: z.string(),
      role: membershipRoleSchema,
      status: membershipStatusSchema,
    }),
  ),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const FULL_NAME_MIN_LENGTH = 2;
export const FULL_NAME_MAX_LENGTH = 100;

const enterFullName = "Enter your full name.";
const onlyNameCharacters =
  "Use only letters, spaces, apostrophes, hyphens and full stops.";

/** Tabs, line breaks, zero-width and direction marks: invisible, or they change how a name reads. */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Any script's letters, with accents, starting with a letter. */
const NAME_PATTERN = /^\p{L}[\p{L}\p{M} '.-]*$/u;

/**
 * The person's name as their M-Pesa account shows it: a cash-out pays in
 * the recipient's name (spec §6.2). Trimmed, with runs of spaces and typographic
 * apostrophes (iOS types ’) made plain.
 */
export const fullNameSchema = z
  .string({ error: enterFullName })
  .trim()
  .refine((name) => !INVISIBLE_CHARACTERS.test(name), {
    error: onlyNameCharacters,
  })
  .transform((name) => name.replace(/ {2,}/g, " ").replace(/[‘’]/g, "'"))
  .pipe(
    z
      .string()
      .min(FULL_NAME_MIN_LENGTH, enterFullName)
      .max(
        FULL_NAME_MAX_LENGTH,
        `Keep your name to ${FULL_NAME_MAX_LENGTH} characters or fewer.`,
      )
      .regex(NAME_PATTERN, onlyNameCharacters),
  );

/** `PATCH /me`: the signed-in person's own details. */
export const updateMeRequestSchema = z.object({ fullName: fullNameSchema });

/** What the app sends; the API trims and tidies the name. */
export type UpdateMeRequest = z.input<typeof updateMeRequestSchema>;

export const updateMeResponseSchema = meResponseSchema.shape.user;

export type UpdateMeResponse = z.infer<typeof updateMeResponseSchema>;
