"use client";

import { cn } from "cn";
import Link from "next/link";

import type { NavItem } from "~/config/navigation";
import type { NavCounts } from "~/hooks/use-nav-counts";

const GROUPS: readonly NavItem["group"][] = [
  "Workspace",
  "Spend & pay",
  "Manage",
  "Insights",
];

export function isCurrent(item: NavItem, path: string): boolean {
  return path === item.href || path.startsWith(`${item.href}/`);
}

export function NavMain({
  items,
  path,
  counts,
  onNavigate,
}: {
  items: readonly NavItem[];
  path: string;
  counts: NavCounts;
  onNavigate: () => void;
}) {
  return (
    <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      {GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group);
        if (groupItems.length === 0) return null;
        return (
          <div key={group} className="mt-4">
            <p className="px-2 pb-1 text-xs leading-4 font-(--w-ui) text-gray-400">
              {group}
            </p>
            {groupItems.map((item) => {
              const active = isCurrent(item, path);
              const count = item.count ? counts[item.count] : undefined;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "flex h-10 items-center gap-2.5 rounded-control px-2 transition-colors duration-150",
                    active
                      ? "bg-brand-50 font-(--w-ui) text-brand-800"
                      : "text-gray-700 hover:bg-gray-50",
                  )}
                >
                  <item.icon
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-brand-700" : "text-gray-400",
                    )}
                  />
                  <span className="min-w-0 truncate">{item.title}</span>
                  {count ? (
                    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-100 px-1.5 text-xs font-(--w-strong) text-brand-800 tabular-nums">
                      {count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
