"use client";

import { usePathname } from "next/navigation";

import { Separator } from "~/components/ui/separator";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { NAV_ITEMS } from "~/config/navigation";

export function SiteHeader() {
  const pathname = usePathname();
  const current = NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return (
    <header className="flex h-16 min-w-0 shrink-0 items-center gap-2 border-b bg-card px-4 sm:px-6 lg:px-8">
      <SidebarTrigger />
      <Separator
        orientation="vertical"
        className="mx-2 data-[orientation=vertical]:h-4"
      />
      <p className="truncate text-sm font-medium">
        {current?.title ?? "Expendi Business"}
      </p>
    </header>
  );
}
