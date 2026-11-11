"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";

import type { Account } from "~/components/shell/account-menu";
import type { NavCounts } from "~/hooks/use-nav-counts";
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
import { HOME_PATH, NAV_ITEMS } from "~/config/navigation";
import { usePreferencesStore } from "~/stores/preferences/preferences-provider";

function Identity({ companyName }: { companyName: string }) {
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg">
        <BrandMark />
      </span>
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate font-semibold">Expendi Business</span>
        <span
          className="truncate text-xs text-muted-foreground"
          title={companyName}
        >
          {companyName}
        </span>
      </span>
    </>
  );
}

/**
 * The brand and company (a company switcher when there's more than one),
 * the grouped pages with their badges, and the person signed in. Its style
 * and how it collapses come from the layout controls.
 */
export function AppSidebar({
  path,
  counts,
  account,
}: {
  path: string;
  counts: NavCounts;
  account: Account;
}) {
  const { variant, collapsible } = usePreferencesStore(
    useShallow((state) => ({
      variant: state.values.sidebar_variant,
      collapsible: state.values.sidebar_collapsible,
    })),
  );
  const { setOpenMobile } = useSidebar();
  const { companyName, onSwitchCompany } = account;
  return (
    <Sidebar variant={variant} collapsible={collapsible}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {onSwitchCompany ? (
              <SidebarMenuButton
                size="lg"
                tooltip="Switch company"
                aria-label={`${companyName}, ${account.role}. Switch company`}
                onClick={() => {
                  setOpenMobile(false);
                  onSwitchCompany();
                }}
              >
                <Identity companyName={companyName} />
                <ChevronsUpDownIcon
                  aria-hidden="true"
                  className="ml-auto text-muted-foreground"
                />
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton size="lg" asChild>
                <Link href={HOME_PATH} onClick={() => setOpenMobile(false)}>
                  <Identity companyName={companyName} />
                </Link>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={NAV_ITEMS} path={path} counts={counts} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser account={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
