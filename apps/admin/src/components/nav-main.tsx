"use client";

import Link from "next/link";

import type { NavItem } from "~/config/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";

export function isCurrent(item: NavItem, path: string): boolean {
  return path === item.href || path.startsWith(`${item.href}/`);
}

export function NavMain({
  items,
  path,
}: {
  items: readonly NavItem[];
  path: string;
}) {
  const { setOpenMobile } = useSidebar();
  const groups = [...new Set(items.map((item) => item.group))];
  return (
    <nav aria-label="Main">
      {groups.map((group) => (
        <SidebarGroup key={group}>
          <SidebarGroupLabel>{group}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items
                .filter((item) => item.group === group)
                .map((item) => {
                  const active = isCurrent(item, path);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.title}
                        className="data-active:bg-accent data-active:text-accent-foreground data-active:[&>svg]:text-accent-foreground [&>svg]:text-muted-foreground"
                      >
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          onClick={() => setOpenMobile(false)}
                        >
                          <item.icon aria-hidden="true" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  );
}
