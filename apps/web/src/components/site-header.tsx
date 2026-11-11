"use client";

import { cn } from "cn";

import type { Account } from "~/components/shell/account-menu";
import { isCurrent } from "~/components/nav-main";
import {
  accountInitials,
  AccountMenuItems,
} from "~/components/shell/account-menu";
import { LayoutControls } from "~/components/shell/layout-controls";
import { SearchDialog } from "~/components/shell/search-dialog";
import { ThemeSwitcher } from "~/components/shell/theme-switcher";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Separator } from "~/components/ui/separator";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { NAV_ITEMS } from "~/config/navigation";

/**
 * The template's 48px header: the sidebar toggle, the current page and
 * page search on the left; the layout controls, theme and account on the
 * right. It sticks to the top or scrolls away, as the layout controls say.
 */
export function SiteHeader({
  path,
  account,
}: {
  path: string;
  account: Account;
}) {
  const current = NAV_ITEMS.find((item) => isCurrent(item, path));
  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b",
        "[html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0 [html[data-navbar-style=sticky]_&]:z-30 [html[data-navbar-style=sticky]_&]:overflow-hidden [html[data-navbar-style=sticky]_&]:rounded-t-[inherit] [html[data-navbar-style=sticky]_&]:bg-background/80 [html[data-navbar-style=sticky]_&]:backdrop-blur-md",
      )}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2 px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-1 lg:gap-2">
          <SidebarTrigger className="-ml-1 size-8" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
          />
          <p className="min-w-0 truncate text-sm font-medium">
            {current?.title ?? account.companyName}
          </p>
          <span className="ml-1 shrink-0 lg:ml-3">
            <SearchDialog items={NAV_ITEMS} />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <LayoutControls />
          <ThemeSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Account menu for ${account.email}`}
              className="ml-1 rounded-lg"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">
                  {accountInitials(account)}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="min-w-56 rounded-lg"
              side="bottom"
              align="end"
              sideOffset={4}
            >
              <AccountMenuItems account={account} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
