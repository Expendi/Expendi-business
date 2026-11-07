"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import Image from "next/image";

import type { NavCounts } from "~/hooks/use-nav-counts";
import { NavMain } from "~/components/nav-main";
import { NavUser } from "~/components/nav-user";
import { NAV_ITEMS } from "~/config/navigation";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";

/** The company switcher, the grouped pages with their badges, and the person signed in. */
export function AppSidebar({
  path,
  counts,
  name,
  email,
  onSwitchCompany,
  onSignOut,
  onNavigate,
}: {
  path: string;
  counts: NavCounts;
  name: string | null;
  email: string;
  onSwitchCompany: (() => void) | null;
  onSignOut: () => void;
  onNavigate: () => void;
}) {
  const { company } = useDashboard();
  const role = ROLE_LABELS[company.role];
  const identity = (
    <>
      <Image
        src="/expendi-mark.png"
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-control"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate font-(--w-name) text-gray-900"
          title={company.name}
        >
          {company.name}
        </span>
        <span className="text-xs leading-4 text-gray-500">{role}</span>
      </span>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-sm">
      <div className="flex flex-col gap-2.5 px-3 pt-4 pb-2">
        {onSwitchCompany ? (
          <button
            type="button"
            onClick={onSwitchCompany}
            aria-label={`${company.name}, ${role}. Switch company`}
            className="flex w-full items-center gap-2.5 rounded-control border-0 bg-transparent px-2 py-1.5 text-left transition-colors duration-150 hover:bg-gray-50"
          >
            {identity}
            <ChevronsUpDownIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-gray-400"
            />
          </button>
        ) : (
          <div className="flex w-full items-center gap-2.5 px-2 py-1.5">
            {identity}
          </div>
        )}
      </div>
      <NavMain
        items={NAV_ITEMS}
        path={path}
        counts={counts}
        onNavigate={onNavigate}
      />
      <NavUser
        name={name}
        email={email}
        role={role}
        onSignOut={onSignOut}
        onSwitchCompany={onSwitchCompany}
      />
    </div>
  );
}
