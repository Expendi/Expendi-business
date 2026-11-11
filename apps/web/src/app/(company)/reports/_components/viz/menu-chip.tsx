"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, KeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { FilterOption } from "~/components/data/filter-chip";
import {
  FilterMenuPanel,
  FilterOptionList,
} from "~/components/data/filter-chip";

const CloseMenuContext = createContext<(returnFocus: boolean) => void>(
  () => undefined,
);

/** Closes the menu a footer is in, e.g. after its form is sent. */
export function useCloseMenu(): (returnFocus: boolean) => void {
  return use(CloseMenuContext);
}

/**
 * A chip that always has a value, e.g. the month or the months shown,
 * opening a listbox menu like the filter chips. `footer` adds a form under
 * the options, e.g. "Another month".
 */
export function MenuChip({
  icon: Icon,
  label,
  display,
  options,
  value,
  onChange,
  footer,
  disabled = false,
}: {
  icon: LucideIcon;
  /** What it chooses, read out before the value, e.g. "Month". */
  label: string;
  display: ReactNode;
  options: readonly FilterOption[];
  value: string;
  onChange: (value: string) => void;
  /** Under the options; it can close the menu with `useCloseMenu`. */
  footer?: ReactNode;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) chip.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={chip}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="inline-flex h-9 items-center gap-2 rounded-control border border-input bg-card px-3 text-sm font-(--w-ui) whitespace-nowrap text-secondary-foreground transition-colors duration-150 hover:not-disabled:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:border-foreground"
      >
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="sr-only">{label}: </span>
        {display}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
      </button>
      {open ? (
        <ChipMenu
          anchor={chip}
          label={label}
          options={options}
          current={value}
          footer={footer}
          onChoose={(choice) => {
            close(true);
            if (choice !== value) onChange(choice);
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function ChipMenu({
  anchor,
  label,
  options,
  current,
  footer,
  onChoose,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  label: string;
  options: readonly FilterOption[];
  current: string;
  footer: ReactNode;
  onChoose: (value: string) => void;
  onClose: (returnFocus: boolean) => void;
}): JSX.Element {
  const listId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === current),
    ),
  );
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    const panel = menu.current;
    const trigger = anchor.current;
    if (!panel || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = rect.bottom + 6;
    const fitsBelow = below + panel.offsetHeight <= window.innerHeight - 8;
    setPosition({
      left: Math.max(
        8,
        Math.min(
          rect.right - panel.offsetWidth,
          window.innerWidth - panel.offsetWidth - 8,
        ),
      ),
      top: fitsBelow ? below : Math.max(8, rect.top - panel.offsetHeight - 6),
    });
  }, [anchor]);

  const placed = position !== null;
  useEffect(() => {
    if (placed) list.current?.focus();
  }, [placed]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !menu.current?.contains(target) &&
        !anchor.current?.contains(target)
      ) {
        onClose(false);
      }
    }
    function onScroll(event: Event) {
      if (!menu.current?.contains(event.target as Node)) onClose(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (
      event.target instanceof Node &&
      footerRef.current?.contains(event.target)
    ) {
      return;
    }
    const last = options.length - 1;
    const moves: Partial<Record<string, number>> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      setActive(move);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) onChoose(option.value);
    } else if (event.key === "Tab" && !footer) {
      onClose(false);
    }
  }

  return createPortal(
    <FilterMenuPanel
      ref={menu}
      onKeyDown={onKeyDown}
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <FilterOptionList
        ref={list}
        id={listId}
        label={label}
        options={options}
        current={current}
        active={active}
        onChoose={onChoose}
        onActivate={setActive}
      />
      {footer ? (
        <div
          ref={footerRef}
          className="flex flex-col gap-1.5 border-t border-border px-3 pt-2.5 pb-3"
        >
          <CloseMenuContext value={onClose}>{footer}</CloseMenuContext>
        </div>
      ) : null}
    </FilterMenuPanel>,
    document.body,
  );
}
