"use client";

import { usePathname } from "next/navigation";

import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { navItems } from "~/config/navigation";

export function SiteHeader() {
  const pathname = usePathname();
  const current = navItems.find(
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
        {current?.title ?? "Operations"}
      </p>
      <Badge variant="outline" className="ml-auto">
        Internal
      </Badge>
    </header>
  );
}
