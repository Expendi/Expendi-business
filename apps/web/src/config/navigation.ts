export interface NavItem {
  title: string;
  href: string;
}

/**
 * Admins and accountants see the same pages: accountants see everything,
 * read-only (spec §4). What differs is that only admins get actions.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { title: "Overview", href: "/overview" },
  { title: "Approvals", href: "/approvals" },
  { title: "Expenses", href: "/expenses" },
  { title: "Bills", href: "/bills" },
  { title: "Recurring", href: "/recurring" },
  { title: "Payees", href: "/payees" },
  { title: "Payroll", href: "/payroll" },
  { title: "Wallet", href: "/wallet" },
  { title: "Team", href: "/team" },
  { title: "Settings", href: "/settings" },
  { title: "Activity", href: "/activity" },
  { title: "Reports", href: "/reports" },
];

export const HOME_PATH = "/overview";
