import type { MembershipRole } from "@expendi-business/shared";

export const ROLE_LABELS: Record<MembershipRole, string> = {
  admin: "Admin",
  employee: "Employee",
  accountant: "Accountant",
};

/** Employees use only the app (spec §6.14). */
export type DashboardRole = Exclude<MembershipRole, "employee">;

export function isDashboardRole(role: MembershipRole): role is DashboardRole {
  return role !== "employee";
}
