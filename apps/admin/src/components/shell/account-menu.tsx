"use client";

import type { JSX } from "react";
import { LogOutIcon } from "lucide-react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";

export interface Account {
  email: string;
  role: string;
  onSignOut: () => void;
}

/** The first two letters of the email, which is all the staff list holds. */
export function accountInitials({ email }: Account): string {
  return email.slice(0, 2).toUpperCase();
}

/** Who is signed in and their role, then Sign out; shared by the sidebar footer and the header avatar. */
export function AccountMenuItems({
  account,
}: {
  account: Account;
}): JSX.Element {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {account.email}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {account.role}
          </span>
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onSelect={account.onSignOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}
