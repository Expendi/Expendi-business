import { z } from "zod";

export const MEMBERSHIP_ROLES = ["admin", "employee", "accountant"] as const;
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const MEMBERSHIP_STATUSES = ["invited", "active", "removed"] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

/**
 * Roles that see everything in their company (spec §4): admins, and
 * accountants, who only read. Employees see only their own things.
 */
export const COMPANY_READER_ROLES = [
  "admin",
  "accountant",
] as const satisfies readonly MembershipRole[];

export function readsWholeCompany(role: MembershipRole): boolean {
  return (COMPANY_READER_ROLES as readonly MembershipRole[]).includes(role);
}

/**
 * Accountants use only the web dashboard (spec §4, §6.14); the app tells an
 * accountant who signs in to go there.
 */
export const WEB_DASHBOARD_URL = "https://business.expendi.app";
