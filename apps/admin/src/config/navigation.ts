export interface NavItem {
  title: string;
  href: string;
}

export const navItems: NavItem[] = [
  { title: "Companies", href: "/companies" },
  { title: "Payouts", href: "/payouts" },
  { title: "Controls", href: "/controls" },
  { title: "Audit log", href: "/audit-log" },
  { title: "Zoho Books", href: "/zoho-books" },
];
