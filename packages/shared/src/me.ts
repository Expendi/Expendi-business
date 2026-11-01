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
