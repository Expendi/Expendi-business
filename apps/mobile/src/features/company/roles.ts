import type { MembershipRole } from "@expendi-business/shared";

export const ROLE_LABELS: Record<MembershipRole, string> = {
  admin: "Admin",
  employee: "Employee",
  accountant: "Accountant",
};

/** What each role can do (spec §4), worded for the person choosing it. */
export const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  admin: "Approves and pays reimbursements, and manages the wallet and team.",
  employee: "Submits their own reimbursements and gets paid to M-Pesa.",
  accountant:
    "View-only access at business.expendi.app, plus monthly exports by email.",
};
