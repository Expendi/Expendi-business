import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  BanknoteIcon,
  Building2Icon,
  ChartColumnIcon,
  CircleCheckIcon,
  CreditCardIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  SettingsIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";

/** The sidebar badges: what's waiting on each of these pages. */
export type NavCountKey = "approvals" | "expenses" | "bills" | "payroll";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  group: "Workspace" | "Spend & pay" | "Manage" | "Insights";
  count?: NavCountKey;
}

/**
 * Admins and accountants see the same pages: accountants see everything,
 * read-only (spec §4). What differs is that only admins get actions.
 * Recurring payments open from Bills; the wallet is "Accounts" at `/wallet`.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    title: "Overview",
    href: "/overview",
    icon: LayoutDashboardIcon,
    group: "Workspace",
  },
  { title: "Accounts", href: "/wallet", icon: WalletIcon, group: "Workspace" },
  {
    title: "Approvals",
    href: "/approvals",
    icon: CircleCheckIcon,
    group: "Spend & pay",
    count: "approvals",
  },
  {
    title: "Expenses",
    href: "/expenses",
    icon: ReceiptTextIcon,
    group: "Spend & pay",
    count: "expenses",
  },
  {
    title: "Cards",
    href: "/cards",
    icon: CreditCardIcon,
    group: "Spend & pay",
  },
  {
    title: "Bills",
    href: "/bills",
    icon: FileTextIcon,
    group: "Spend & pay",
    count: "bills",
  },
  {
    title: "Payroll",
    href: "/payroll",
    icon: BanknoteIcon,
    group: "Spend & pay",
    count: "payroll",
  },
  { title: "Payees", href: "/payees", icon: Building2Icon, group: "Manage" },
  { title: "Team", href: "/team", icon: UsersIcon, group: "Manage" },
  { title: "Settings", href: "/settings", icon: SettingsIcon, group: "Manage" },
  {
    title: "Reports",
    href: "/reports",
    icon: ChartColumnIcon,
    group: "Insights",
  },
  {
    title: "Activity",
    href: "/activity",
    icon: ActivityIcon,
    group: "Insights",
  },
];

export const HOME_PATH = "/overview";
