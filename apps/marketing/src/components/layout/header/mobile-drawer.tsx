"use client";

import type { JSX } from "react";
import { useRef } from "react";

import { ChevronRightIcon } from "~/components/icons";
import { NAV_MENUS } from "~/content/navigation";
import { EASE, gsap, useGSAP } from "~/lib/gsap";
import { motionDuration, SIGN_IN_HREF, SIGN_UP_HREF } from "./constants";
import { LanguageSwitch } from "./language-switch";
import { MenuHighlight } from "./menu-highlight";

function slide(target: HTMLElement, open: boolean, seconds: number): void {
  gsap.killTweensOf(target);
  const duration = motionDuration(seconds);
  if (duration === 0) {
    gsap.set(target, {
      x: 0,
      xPercent: open ? 0 : 100,
      visibility: open ? "visible" : "hidden",
    });
    return;
  }
  if (open) gsap.set(target, { visibility: "visible" });
  const timeline = gsap.timeline().to(target, {
    // Strict Mode can reparse a percentage transform as a pixel translation.
    // Reset both translation components so the offset cannot accumulate.
    x: 0,
    xPercent: open ? 0 : 100,
    duration,
    ease: EASE.qonto,
    overwrite: true,
  });
  // Keep the closing panel visible during travel. Register the final set in
  // the scoped timeline too, so interruption and unmount clean it up.
  if (!open) timeline.set(target, { visibility: "hidden" });
}

interface MobileDrawerProps {
  id: string;
  open: boolean;
  category: number;
  categoryOpen: boolean;
  onSelectCategory: (index: number) => void;
}

/**
 * <1024px full-height menu sliding in from the right under the 64px bar, with
 * a second panel per category that slides over the top-level list.
 */
export function MobileDrawer({
  id,
  open,
  category,
  categoryOpen,
  onSelectCategory,
}: MobileDrawerProps): JSX.Element {
  const drawerRef = useRef<HTMLDivElement>(null);
  const categoryRef = useRef<HTMLDivElement>(null);
  const menu = NAV_MENUS[category];

  useGSAP(
    () => {
      const drawer = drawerRef.current;
      const panel = categoryRef.current;
      if (!drawer || !panel) return;
      gsap.set([drawer, panel], { x: 0, xPercent: 100 });
    },
    { scope: drawerRef },
  );

  useGSAP(
    () => {
      if (drawerRef.current) slide(drawerRef.current, open, 0.35);
    },
    { scope: drawerRef, dependencies: [open] },
  );

  useGSAP(
    () => {
      const panel = categoryRef.current;
      if (!panel) return;
      if (categoryOpen) panel.scrollTop = 0;
      slide(panel, categoryOpen, 0.3);
    },
    { scope: drawerRef, dependencies: [categoryOpen] },
  );

  return (
    <div
      ref={drawerRef}
      id={id}
      inert={!open}
      className="bg-primary-white text-primary-black invisible absolute inset-x-0 top-0 -z-1 h-dvh overflow-hidden lg:hidden"
    >
      <div
        inert={categoryOpen}
        className="flex h-full flex-col justify-between overflow-y-auto px-20 pt-96 pb-32"
      >
        <div>
          <ul>
            {NAV_MENUS.map((item, index) => (
              <li key={item.title}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectCategory(index);
                  }}
                  className="flex w-full cursor-pointer items-center justify-between py-14 text-left"
                >
                  <span className="grow text-24 leading-32 font-semibold lining-nums proportional-nums md:text-28 md:leading-36">
                    {item.title}
                  </span>
                  <ChevronRightIcon className="size-16 flex-none" />
                </button>
              </li>
            ))}
          </ul>
          <LanguageSwitch variant="mobile" />
        </div>
        <div className="flex flex-col gap-y-32">
          <a
            href={SIGN_UP_HREF}
            className="bg-primary-black text-primary-white block rounded-lg px-16 py-12 text-center text-16 leading-26"
          >
            Open an account
          </a>
          <a href={SIGN_IN_HREF} className="text-center text-16 leading-26">
            <span className="border-primary-black inline-block border-b pb-7">
              Sign in
            </span>
          </a>
        </div>
      </div>
      <div
        ref={categoryRef}
        inert={!categoryOpen}
        aria-label={menu?.title}
        role="region"
        className="bg-primary-white invisible absolute inset-0 overflow-y-auto px-20 pt-83"
      >
        {menu ? (
          <div className="mt-20 mb-32">
            {menu.columns.flat().map((group) => (
              <div key={group.category}>
                <p className="text-grey-700 mt-32 mb-6 text-14 leading-22">
                  {group.category}
                </p>
                <ul>
                  {group.items.map(({ label, href, icon: Icon }) => (
                    <li key={label}>
                      <a
                        href={href}
                        className="flex items-center py-13 text-16 leading-26"
                      >
                        {Icon ? (
                          <Icon className="mr-10 size-20 flex-none" />
                        ) : null}
                        <span>{label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {menu.highlight ? (
              <MenuHighlight highlight={menu.highlight} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
