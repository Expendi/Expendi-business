"use client";

import Link from "next/link";

import type { NavItem } from "~/config/navigation";
import type { NavCounts } from "~/hooks/use-nav-counts";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";

const GROUPS: readonly NavItem["group"][] = [
  "Workspace",
  "Spend & pay",
  "Get paid",
  "Manage",
  "Insights",
];

export function isCurrent(item: NavItem, path: string): boolean {
  return path === item.href || path.startsWith(`${item.href}/`);
}

/** The grouped pages, the current one marked, with their waiting counts. */
export function NavMain({
  items,
  path,
  counts,
}: {
  items: readonly NavItem[];
  path: string;
  counts: NavCounts;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="Main">
      {GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) return null;
        return (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {groupItems.map((item) => {
                  const active = isCurrent(item, path);
                  const count = item.count ? counts[item.count] : undefined;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={
                          count
                            ? `${item.title} (${String(count)})`
                            : item.title
                        }
                        className="data-active:bg-accent data-active:text-accent-foreground data-active:[&>svg]:text-accent-foreground [&>svg]:text-muted-foreground"
                      >
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          onClick={() => setOpenMobile(false)}
                        >
                          <item.icon aria-hidden="true" />
                          <span>{item.title}</span>
                          {count ? (
                            <span className="sr-only">
                              , {String(count)} waiting
                            </span>
                          ) : null}
                        </Link>
                      </SidebarMenuButton>
                      {count ? (
                        <SidebarMenuBadge
                          aria-hidden="true"
                          className="rounded-full bg-brand-100 text-brand-800 peer-hover/menu-button:text-brand-800 peer-data-active/menu-button:text-brand-800"
                        >
                          {count}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </nav>
  );
}
