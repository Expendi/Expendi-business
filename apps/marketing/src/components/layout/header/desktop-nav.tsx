"use client";

import type { FocusEvent, JSX, PointerEvent as ReactPointerEvent } from "react";
import { Fragment, useRef } from "react";

import type { NavMenu } from "~/types/content";
import { NAV_MENUS } from "~/content/navigation";
import { EASE, gsap, useGSAP } from "~/lib/gsap";
import { cn } from "~/lib/utils";
import { motionDuration } from "./constants";
import { MenuHighlight } from "./menu-highlight";

const PANEL_OFFSET = -32;
const TRIGGER_ACTIVE = "rgb(5, 5, 5)";
const TRIGGER_MUTED = "rgba(26, 26, 26, 0.7)";
const ITEM_ACTIVE = "rgb(5, 5, 5)";
const ITEM_DIMMED = "rgb(97, 97, 97)";
const ITEM_SELECTOR = "[data-submenu-item]";

interface DesktopNavProps {
  activeMenu: number | null;
  onActiveMenuChange: (index: number | null) => void;
}

/** ≥1024px row of mega-menu triggers; each `li` is an 80px-tall hover target. */
export function DesktopNav({
  activeMenu,
  onActiveMenuChange,
}: DesktopNavProps): JSX.Element {
  return (
    <ul className="hidden gap-24 lg:flex">
      {NAV_MENUS.map((menu, index) => (
        <NavTrigger
          key={menu.title}
          menu={menu}
          index={index}
          activeMenu={activeMenu}
          onActiveMenuChange={onActiveMenuChange}
        />
      ))}
    </ul>
  );
}

interface NavTriggerProps extends DesktopNavProps {
  menu: NavMenu;
  index: number;
}

function NavTrigger({
  menu,
  index,
  activeMenu,
  onActiveMenuChange,
}: NavTriggerProps): JSX.Element {
  const itemRef = useRef<HTMLLIElement>(null);
  const pointerType = useRef("");
  const open = activeMenu === index;
  const tone = activeMenu === null ? "idle" : open ? "active" : "muted";
  const panelId = `navigation-item-${index}`;

  useGSAP(
    () => {
      const item = itemRef.current;
      if (!item) return;
      if (tone === "idle") {
        gsap.set(item, { clearProps: "color", overwrite: true });
        return;
      }
      gsap.to(item, {
        color: tone === "active" ? TRIGGER_ACTIVE : TRIGGER_MUTED,
        duration: motionDuration(0.2),
        ease: EASE.css,
        overwrite: true,
      });
    },
    { scope: itemRef, dependencies: [tone] },
  );

  const handlePointerEnter = (
    event: ReactPointerEvent<HTMLLIElement>,
  ): void => {
    if (event.pointerType === "mouse") onActiveMenuChange(index);
  };

  const handlePointerLeave = (
    event: ReactPointerEvent<HTMLLIElement>,
  ): void => {
    if (event.pointerType === "mouse" && open) onActiveMenuChange(null);
  };

  const handleBlur = (event: FocusEvent<HTMLLIElement>): void => {
    const next = event.relatedTarget;
    const focusStaysInside =
      next instanceof Node && event.currentTarget.contains(next);
    if (open && !focusStaysInside) onActiveMenuChange(null);
  };

  const handleClick = (): void => {
    const openedByHover = pointerType.current === "mouse";
    pointerType.current = "";
    onActiveMenuChange(openedByHover || !open ? index : null);
  };

  return (
    <li
      ref={itemRef}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onBlur={handleBlur}
      className="relative flex h-80 items-center"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType;
        }}
        onClick={handleClick}
        className="cursor-pointer text-left text-16 leading-20"
      >
        {menu.title}
      </button>
      <MegaMenuPanel id={panelId} menu={menu} open={open} />
    </li>
  );
}

interface MegaMenuPanelProps {
  id: string;
  menu: NavMenu;
  open: boolean;
}

/**
 * White 32px-radius panel 16px under the bar. The transparent `pt-16` strip is
 * the hover bridge from trigger to panel. Panels that would run past the
 * viewport are centred in it instead (qonto.com does this for "Credit").
 */
function MegaMenuPanel({ id, menu, open }: MegaMenuPanelProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const columns = menu.columns.length + (menu.highlight ? 1 : 0);

  const { contextSafe } = useGSAP(
    () => {
      const wrapper = wrapperRef.current;
      const trigger = wrapper?.parentElement;
      if (!wrapper || !trigger) return;
      if (!open) {
        gsap.set(ITEM_SELECTOR, { clearProps: "color", overwrite: true });
        return;
      }
      const triggerLeft = trigger.getBoundingClientRect().left;
      const viewportWidth = document.documentElement.clientWidth;
      const width = wrapper.offsetWidth;
      const overflows = triggerLeft + PANEL_OFFSET + width > viewportWidth;
      gsap.set(wrapper, {
        left: overflows
          ? (viewportWidth - width) / 2 - triggerLeft
          : PANEL_OFFSET,
      });
    },
    { scope: wrapperRef, dependencies: [open] },
  );

  const spotlight = contextSafe((target: Element | null): void => {
    const tween = {
      duration: motionDuration(0.2),
      ease: EASE.qonto,
      overwrite: true,
    };
    gsap.to(ITEM_SELECTOR, {
      ...tween,
      color: target ? ITEM_DIMMED : ITEM_ACTIVE,
    });
    if (target) gsap.to(target, { ...tween, color: ITEM_ACTIVE });
  });

  return (
    <div
      ref={wrapperRef}
      id={id}
      style={{ width: columns * 273 + (columns - 1) * 24 + 64 }}
      className={cn(
        "absolute top-full left-[-32px] z-1000 max-w-[100vw] pt-16",
        open ? "block" : "hidden",
      )}
    >
      <div className="bg-primary-white text-primary-black overflow-hidden rounded-[32px]">
        <div
          className="grid gap-24 p-32"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {menu.columns.map((column, columnIndex) => (
            <ul key={columnIndex} className="min-w-0">
              {column.map((group) => (
                <Fragment key={group.category}>
                  <li className="text-grey-700 mt-32 mb-6 text-14 leading-22 first:mt-0">
                    {group.category}
                  </li>
                  {group.items.map(({ label, href, icon: Icon }) => (
                    <li key={label}>
                      <a
                        href={href}
                        data-submenu-item
                        onPointerEnter={(event) => {
                          spotlight(event.currentTarget);
                        }}
                        onPointerLeave={() => {
                          spotlight(null);
                        }}
                        className="flex items-center py-14 text-16 leading-26"
                      >
                        {Icon ? (
                          <Icon className="mr-10 size-22 flex-none" />
                        ) : null}
                        <span>{label}</span>
                      </a>
                    </li>
                  ))}
                </Fragment>
              ))}
            </ul>
          ))}
          {menu.highlight ? (
            <div className="mb-8 flex min-w-0 flex-col">
              <MenuHighlight highlight={menu.highlight} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
