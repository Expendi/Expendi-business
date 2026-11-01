import { z } from "zod";

import { membershipRoleSchema } from "./membership.js";
import { walletSetupSchema } from "./wallet.js";

/** A letter (A for a person, P for a business), 9 digits and a letter (spec §6.1). */
export const KRA_PIN_PATTERN = /^[AP]\d{9}[A-Z]$/;

export const ORGANIZATION_NAME_MAX_LENGTH = 120;

const enterName = "Enter the company name.";

export const kraPinSchema = z
  .string({ error: "Enter the company's KRA PIN." })
  .trim()
  .toUpperCase()
  .regex(
    KRA_PIN_PATTERN,
    "That isn't a valid KRA PIN. It's A or P, then 9 digits and a letter, e.g. P051234567X.",
  );

export const createOrganizationRequestSchema = z.object({
  name: z
    .string({ error: enterName })
    .trim()
    .min(1, enterName)
    .max(
      ORGANIZATION_NAME_MAX_LENGTH,
      `Keep the company name to ${ORGANIZATION_NAME_MAX_LENGTH} characters or fewer.`,
    ),
  kraPin: kraPinSchema,
});

/** What the app sends; the API trims both fields and uppercases the PIN. */
export type CreateOrganizationRequest = z.input<
  typeof createOrganizationRequestSchema
>;

export const organizationResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Null only for companies set up before sign-up collected it. */
  kraPin: z.string().nullable(),
  role: membershipRoleSchema,
});

export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;

export const createOrganizationResponseSchema =
  organizationResponseSchema.extend({ wallet: walletSetupSchema });

export type CreateOrganizationResponse = z.infer<
  typeof createOrganizationResponseSchema
>;
