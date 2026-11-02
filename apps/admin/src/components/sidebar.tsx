"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { StaffMeResponse, StaffRole } from "@expendi-business/shared";

import { navItems } from "~/config/navigation";

const ROLE_LABELS: Record<StaffRole, string> = {
  ops_admin: "Ops admin",
  ops_viewer: "Ops viewer",
};

export function Sidebar({
  staff,
  onSignOut,
}: {
  staff: StaffMeResponse;
  onSignOut: () => void;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-stone-200 bg-white">
      <div className="px-5 py-5">
        <p className="text-sm font-semibold">Expendi Business</p>
        <p className="text-xs text-stone-500">Ops</p>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 px-3">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "block rounded-md bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700"
                  : "block rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-stone-100"
              }
            >
              {item.title}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-stone-200 px-5 py-4">
        <p className="truncate text-sm" title={staff.email}>
          {staff.email}
        </p>
        <p className="text-xs text-stone-500">{ROLE_LABELS[staff.role]}</p>
        <button
          type="button"
          onClick={onSignOut}
          className="mt-3 text-sm font-medium text-stone-700 underline-offset-4 hover:underline"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
