"use client";

import { MenuIcon } from "lucide-react";
import Image from "next/image";

import { IconButton } from "~/components/data/actions";

/** The phone and tablet top bar: the menu button, the mark and the company. Hidden from 900px. */
export function SiteHeader({
  companyName,
  navOpen,
  onOpenNav,
}: {
  companyName: string;
  navOpen: boolean;
  onOpenNav: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 min-w-0 shrink-0 items-center gap-2.5 border-b border-gray-200 bg-surface px-3 min-[900px]:hidden">
      <IconButton
        label="Open navigation"
        aria-expanded={navOpen}
        aria-haspopup="dialog"
        onClick={onOpenNav}
      >
        <MenuIcon aria-hidden="true" />
      </IconButton>
      <Image
        src="/expendi-mark.png"
        alt=""
        width={28}
        height={28}
        className="size-7 shrink-0 rounded-control"
      />
      <span className="min-w-0 truncate text-base font-(--w-name) text-gray-900">
        {companyName}
      </span>
    </header>
  );
}
