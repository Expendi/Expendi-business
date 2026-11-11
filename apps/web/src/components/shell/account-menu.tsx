"use client";

import type { JSX } from "react";
import { Building2Icon, LogOutIcon } from "lucide-react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import { useSidebar } from "~/components/ui/sidebar";

export interface Account {
  name: string | null;
  email: string;
  role: string;
  companyName: string;
  onSwitchCompany: (() => void) | null;
  onSignOut: () => void;
}

/** "Wanjiru Kamau" → "WK"; falls back to the email's first two letters. */
export function accountInitials({ name, email }: Account): string {
  const words = (name ?? email).trim().split(/\s+/);
  const [first = "", second] = words;
  return (
    second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2)
  ).toUpperCase();
}

/**
 * Who is signed in, for which company, then Switch company and Sign out;
 * shared by the sidebar footer and the header avatar.
 */
export function AccountMenuItems({
  account,
}: {
  account: Account;
}): JSX.Element {
  const { setOpenMobile } = useSidebar();
  const { onSwitchCompany } = account;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {account.name ?? account.email}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {account.role} · {account.companyName}
          </span>
        </DropdownMenuLabel>
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
        <DropdownMenuItem onSelect={account.onSignOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}
