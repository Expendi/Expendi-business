"use client";

import type { JSX } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "~/config/navigation";
import { ROLE_LABELS } from "~/config/roles";
import { useDashboard } from "~/contexts/dashboard-context";
import { textButton } from "./styles";

export function Sidebar({
  email,
  onSwitchCompany,
  onSignOut,
}: {
  email: string;
  /** Only for someone in several companies. */
  onSwitchCompany: (() => void) | null;
  onSignOut: () => void;
}): JSX.Element {
  const pathname = usePathname();
  const { company, canAct } = useDashboard();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-stone-200 bg-white">
      <div className="px-5 py-5">
        <p className="text-xs text-stone-500">Expendi Business</p>
        <p className="truncate text-sm font-semibold" title={company.name}>
          {company.name}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <p className="text-xs text-stone-500">{ROLE_LABELS[company.role]}</p>
          {canAct ? null : (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
              View only
            </span>
          )}
        </div>
        {onSwitchCompany ? (
          <button
            type="button"
            onClick={onSwitchCompany}
            className={`mt-2 ${textButton}`}
          >
            Switch company
          </button>
        ) : null}
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
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
        <p className="truncate text-sm" title={email}>
          {email}
        </p>
        <button
          type="button"
          onClick={onSignOut}
          className={`mt-3 ${textButton}`}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
