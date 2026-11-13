"use client";

import Link from "next/link";
import { useShallow } from "zustand/react/shallow";

import type { Account } from "~/components/shell/account-menu";
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
  useSidebar,
} from "~/components/ui/sidebar";
import { navItems } from "~/config/navigation";
import { usePreferencesStore } from "~/stores/preferences/preferences-provider";

/**
 * The brand, the grouped pages and the staff member signed in. Its style
 * and how it collapses come from Settings > Appearance.
 */
export function AppSidebar({
  path,
  account,
}: {
  path: string;
  account: Account;
}) {
  const { variant, collapsible } = usePreferencesStore(
    useShallow((state) => ({
      variant: state.values.sidebar_variant,
      collapsible: state.values.sidebar_collapsible,
    })),
  );
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar variant={variant} collapsible={collapsible}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/companies" onClick={() => setOpenMobile(false)}>
                <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg">
                  <BrandMark />
                </span>
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">
                    Expendi Business Ops
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    Internal
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} path={path} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser account={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
