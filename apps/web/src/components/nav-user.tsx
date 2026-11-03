"use client";

import { Building2Icon, EllipsisVerticalIcon, LogOutIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";

export function NavUser({
  email,
  role,
  onSignOut,
  onSwitchCompany,
}: {
  email: string;
  role: string;
  onSignOut: () => void;
  onSwitchCompany?: (() => void) | null;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={`Account menu for ${email}`}
            >
              <Avatar>
                <AvatarFallback>
                  {email.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 gap-0.5 text-left">
                <span className="truncate font-medium" title={email}>
                  {email}
                </span>
                <span className="text-xs text-muted-foreground">{role}</span>
              </div>
              <EllipsisVerticalIcon aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            align="end"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{role}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onSwitchCompany ? (
                <DropdownMenuItem
                  onSelect={() => {
                    setOpenMobile(false);
                    onSwitchCompany();
                  }}
                >
                  <Building2Icon />
                  Switch company
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={onSignOut}>
                <LogOutIcon />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
