import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  BanknoteIcon,
  ChartBarIcon,
  CircleCheckIcon,
  ContactIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  ReceiptIcon,
  RepeatIcon,
  SettingsIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  group: "Workspace" | "Spend & pay" | "Manage" | "Insights";
}

/**
 * Admins and accountants see the same pages: accountants see everything,
 * read-only (spec §4). What differs is that only admins get actions.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    title: "Overview",
    href: "/overview",
    icon: LayoutDashboardIcon,
    group: "Workspace",
  },
  { title: "Wallet", href: "/wallet", icon: WalletIcon, group: "Workspace" },
  {
    title: "Approvals",
    href: "/approvals",
    icon: CircleCheckIcon,
    group: "Spend & pay",
  },
  {
    title: "Expenses",
    href: "/expenses",
    icon: ReceiptIcon,
    group: "Spend & pay",
  },
  { title: "Bills", href: "/bills", icon: FileTextIcon, group: "Spend & pay" },
  {
    title: "Recurring",
    href: "/recurring",
    icon: RepeatIcon,
    group: "Spend & pay",
  },
  {
    title: "Payroll",
    href: "/payroll",
    icon: BanknoteIcon,
    group: "Spend & pay",
  },
  { title: "Payees", href: "/payees", icon: ContactIcon, group: "Manage" },
  { title: "Team", href: "/team", icon: UsersIcon, group: "Manage" },
  { title: "Settings", href: "/settings", icon: SettingsIcon, group: "Manage" },
  { title: "Reports", href: "/reports", icon: ChartBarIcon, group: "Insights" },
  {
    title: "Activity",
    href: "/activity",
    icon: ActivityIcon,
    group: "Insights",
  },
];

export const HOME_PATH = "/overview";
