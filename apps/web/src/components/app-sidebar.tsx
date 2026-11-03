"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import type { NavItem } from "~/config/navigation";
import { BrandMark } from "~/components/brand-mark";
import { NavMain } from "~/components/nav-main";
import { NavUser } from "~/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "~/components/ui/sidebar";

/** The official dashboard-01 shell, connected to the company session. */
export function AppSidebar({
  title,
  detail,
  email,
  role,
  items,
  onSignOut,
  onSwitchCompany,
}: {
  title: string;
  detail: ReactNode;
  email: string;
  role: string;
  items: readonly NavItem[];
  onSignOut: () => void;
  onSwitchCompany?: (() => void) | null;
}) {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="gap-3 border-b p-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link href="/overview">
                <BrandMark />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate font-semibold">
                    Expendi Business
                  </span>
                  <span
                    className="truncate text-xs text-muted-foreground"
                    title={title}
                  >
                    {title}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground">
          {detail}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} />
      </SidebarContent>
      <SidebarFooter className="border-t p-3">
        <NavUser
          email={email}
          role={role}
          onSignOut={onSignOut}
          onSwitchCompany={onSwitchCompany}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
