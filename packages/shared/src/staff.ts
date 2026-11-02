import { z } from "zod";

/**
 * The Expendi team in the internal admin app (spec §6.15): an ops admin can
 * act, an ops viewer can only look.
 */
export const STAFF_ROLES = ["ops_admin", "ops_viewer"] as const;
export const staffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const STAFF_STATUSES = ["active", "disabled"] as const;
export const staffStatusSchema = z.enum(STAFF_STATUSES);
export type StaffStatus = z.infer<typeof staffStatusSchema>;

/** The signed-in staff member: `GET /internal/me` and `POST /internal/session`. */
export const staffMeResponseSchema = z.object({
  email: z.email(),
  role: staffRoleSchema,
});

export type StaffMeResponse = z.infer<typeof staffMeResponseSchema>;
