"use client";

import Link from "next/link";

import type { StaffMeResponse, StaffRole } from "@expendi-business/shared";

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
import { navItems } from "~/config/navigation";

const ROLE_LABELS: Record<StaffRole, string> = {
  ops_admin: "Ops admin",
  ops_viewer: "Ops viewer",
};

/** The official dashboard-01 shell, connected to the staff session. */
export function AppSidebar({
  staff,
  onSignOut,
}: {
  staff: StaffMeResponse;
  onSignOut: () => void;
}) {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b p-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link href="/companies">
                <BrandMark />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate font-semibold">
                    Expendi Business
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Operations
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
      </SidebarContent>
      <SidebarFooter className="border-t p-3">
        <NavUser
          email={staff.email}
          role={ROLE_LABELS[staff.role]}
          onSignOut={onSignOut}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
