import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BellIcon,
  BookOpenIcon,
  Building2Icon,
  RouteIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  group: "Operations" | "Monitoring" | "Administration";
}

export const navItems: NavItem[] = [
  {
    title: "Companies",
    href: "/companies",
    icon: Building2Icon,
    group: "Operations",
  },
  {
    title: "Payouts",
    href: "/payouts",
    icon: ArrowLeftRightIcon,
    group: "Operations",
  },
  {
    title: "NEAR Intents",
    href: "/intent-quotes",
    icon: RouteIcon,
    group: "Operations",
  },
  { title: "Alerts", href: "/alerts", icon: BellIcon, group: "Monitoring" },
  {
    title: "System health",
    href: "/health",
    icon: ActivityIcon,
    group: "Monitoring",
  },
  {
    title: "Controls",
    href: "/controls",
    icon: SlidersHorizontalIcon,
    group: "Administration",
  },
  {
    title: "Audit log",
    href: "/audit-log",
    icon: ScrollTextIcon,
    group: "Administration",
  },
  {
    title: "Zoho Books",
    href: "/zoho-books",
    icon: BookOpenIcon,
    group: "Administration",
  },
];
