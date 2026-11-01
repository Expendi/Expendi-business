import { z } from "zod";

export const MEMBERSHIP_ROLES = ["admin", "employee", "accountant"] as const;
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const MEMBERSHIP_STATUSES = ["invited", "active", "removed"] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;
