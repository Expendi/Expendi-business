"use client";

import { Building2Icon, LogOutIcon } from "lucide-react";

import { initialsOf } from "~/components/data/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/** The person signed in, at the foot of the sidebar; opens Switch company and Sign out. */
export function NavUser({
  name,
  email,
  role,
  onSignOut,
  onSwitchCompany,
}: {
  name: string | null;
  email: string;
  role: string;
  onSignOut: () => void;
  onSwitchCompany: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${email}`}
          className="flex w-full items-center gap-2.5 border-0 border-t border-gray-200 bg-transparent px-5 pt-3 pb-4 text-left transition-colors duration-150 hover:bg-gray-50 focus-visible:-outline-offset-2"
        >
          <span
            aria-hidden="true"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-(--w-strong) tracking-[0.02em] text-gray-700"
          >
            {initialsOf(name ?? email)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-(--w-name) text-gray-900">
              {name ?? email}
            </span>
            <span
              className="block truncate text-xs leading-4 text-gray-500"
              title={email}
            >
              {email}
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56" side="top" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{role}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {onSwitchCompany ? (
            <DropdownMenuItem onSelect={onSwitchCompany}>
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
  );
}
