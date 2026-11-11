"use client";

import type { LucideIcon } from "lucide-react";
import type {
  CSSProperties,
  JSX,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { cn } from "cn";
import {
  CheckIcon,
  ChevronDownIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { StatusTone } from "./status-badge";
import { TextLinkButton } from "./actions";
import { EntityMark } from "./cells";
import { StatusBadge } from "./status-badge";

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  /** Shows the option as a status badge, as a status filter does. */
  readonly tone?: StatusTone;
  /**
   * Shows initials before the label: a business's (square), as a payee
   * filter does, or with `"person"` a person's (round).
   */
  readonly mark?: boolean | "person";
  readonly icon?: LucideIcon;
}

/** The "Any …" choice, first in every menu; choosing it clears the filter. */
const ANY = "";

/**
 * An option that opens a small form in the menu instead of choosing,
 * e.g. "Custom dates". `render` gets `done` (closes the menu) and `back`
 * (returns to the list).
 */
export interface FilterCustomStep {
  readonly value: string;
  readonly render: (steps: {
    readonly done: () => void;
    readonly back: () => void;
  }) => ReactNode;
}

/**
 * A filter chip. Empty: dashed, with its icon, label and a chevron. Set:
 * coral, "Label: value", with a button that removes the filter. Opens a
 * listbox menu of `anyLabel` and the options.
 */
export function FilterChip({
  label,
  icon: Icon,
  options,
  value,
  onChange,
  anyLabel,
  searchPlaceholder,
  disabled = false,
  valueLabel: shownValue,
  custom,
}: {
  label: string;
  icon: LucideIcon;
  options: readonly FilterOption[];
  /** The chosen option's value; null when the filter is off. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** e.g. "Any status", "Every payee". */
  anyLabel: string;
  /** Adds a search box to a long menu, e.g. "Search payees". */
  searchPlaceholder?: string;
  disabled?: boolean;
  /** The chip's text when set, if not the option's label, e.g. a date range. */
  valueLabel?: string;
  custom?: FilterCustomStep;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const mainRef = useRef<HTMLButtonElement>(null);
  const isSet = value !== null && value !== ANY;
  const valueLabel = isSet
    ? (shownValue ??
      options.find((option) => option.value === value)?.label ??
      value)
    : null;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) mainRef.current?.focus();
  }, []);

  return (
    <span className="inline-flex h-8 shrink-0 items-stretch rounded-full text-sm">
      <button
        ref={mainRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          isSet
            ? `${label}: ${valueLabel ?? ""}. Change`
            : `Filter by ${label.toLowerCase()}`
        }
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-3 font-(--w-ui) whitespace-nowrap transition-[border-color,background-color,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50",
          isSet
            ? cn(
                "rounded-r-none border-r-0 bg-brand-50 pr-1.5 text-brand-800 hover:bg-brand-100",
                open ? "border-brand-700" : "border-brand-100",
              )
            : open
              ? "border-solid border-gray-900 bg-card text-foreground"
              : "border-dashed border-gray-300 bg-card text-secondary-foreground hover:not-disabled:border-solid hover:not-disabled:border-gray-400 hover:not-disabled:text-foreground",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3.5",
            isSet ? "text-brand-700" : "text-muted-foreground",
          )}
        />
        {isSet ? (
          <>
            <span className="font-normal text-brand-700">{label}:</span>
            <span className="max-w-[180px] truncate font-(--w-name) max-[600px]:max-w-[120px]">
              {valueLabel}
            </span>
          </>
        ) : (
          <>
            {label}
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
          </>
        )}
      </button>
      {isSet ? (
        <button
          type="button"
          aria-label={`Remove the ${label.toLowerCase()} filter`}
          onClick={() => {
            onChange(null);
            mainRef.current?.focus();
          }}
          className="inline-flex w-[30px] items-center justify-center rounded-r-full border border-l-0 border-brand-100 bg-brand-50 pr-0.5 text-brand-700 hover:bg-brand-100 hover:text-brand-800"
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      {open ? (
        <FilterMenu
          anchor={mainRef}
          label={label}
          options={options}
          current={value ?? ANY}
          anyLabel={anyLabel}
          searchPlaceholder={searchPlaceholder}
          custom={custom}
          onChoose={(choice) => {
            close(true);
            onChange(choice === ANY ? null : choice);
          }}
          onClose={close}
        />
      ) : null}
    </span>
  );
}

function FilterMenu({
  anchor,
  label,
  options,
  current,
  anyLabel,
  searchPlaceholder,
  custom,
  onChoose,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  label: string;
  options: readonly FilterOption[];
  current: string;
  anyLabel: string;
  searchPlaceholder: string | undefined;
  custom: FilterCustomStep | undefined;
  onChoose: (value: string) => void;
  onClose: (returnFocus: boolean) => void;
}): JSX.Element {
  const listId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [inForm, setInForm] = useState(false);
  const choose = (value: string) => {
    if (custom?.value === value) setInForm(true);
    else onChoose(value);
  };
  const all = useMemo(
    () => [{ value: ANY, label: anyLabel }, ...options],
    [anyLabel, options],
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? all.filter((option) => option.label.toLowerCase().includes(needle))
      : all;
  }, [all, query]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      all.findIndex((option) => option.value === current),
    ),
  );
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = anchor.current;
    if (!menu || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = rect.bottom + 6;
    const fitsBelow = below + menu.offsetHeight <= window.innerHeight - 8;
    setPosition({
      left: Math.max(
        8,
        Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8),
      ),
      top: fitsBelow ? below : Math.max(8, rect.top - menu.offsetHeight - 6),
    });
  }, [anchor, inForm]);

  const placed = position !== null;

  useEffect(() => {
    if (!placed) return;
    if (inForm) menuRef.current?.querySelector("input")?.focus();
    else (searchRef.current ?? listRef.current)?.focus();
  }, [placed, inForm]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !anchor.current?.contains(target)
      ) {
        onClose(false);
      }
    }
    function onScroll(event: Event) {
      if (!menuRef.current?.contains(event.target as Node)) onClose(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  const highlighted = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    document
      .getElementById(`${listId}-${String(highlighted)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [listId, highlighted]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (inForm) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }
      return;
    }
    const last = shown.length - 1;
    const moves: Partial<Record<string, number>> = {
      ArrowDown: Math.min(last, highlighted + 1),
      ArrowUp: Math.max(0, highlighted - 1),
      Home: 0,
      End: last,
    };
    const move = moves[event.key];
    if (move !== undefined && shown.length > 0) {
      event.preventDefault();
      setActive(move);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = shown[highlighted];
      if (option) choose(option.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "Tab") {
      onClose(false);
    }
  }

  const style: CSSProperties = position
    ? { left: position.left, top: position.top }
    : { left: 0, top: 0, visibility: "hidden" };

  if (inForm && custom) {
    return createPortal(
      <FilterMenuPanel ref={menuRef} onKeyDown={onKeyDown} style={style} wide>
        {custom.render({
          done: () => onClose(true),
          back: () => setInForm(false),
        })}
      </FilterMenuPanel>,
      document.body,
    );
  }

  return createPortal(
    <FilterMenuPanel
      ref={menuRef}
      onKeyDown={onKeyDown}
      style={style}
      search={
        searchPlaceholder ? (
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listId}
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        ) : null
      }
    >
      <FilterOptionList
        ref={listRef}
        id={listId}
        label={label}
        options={shown}
        current={current}
        active={highlighted}
        onChoose={choose}
        onActivate={setActive}
      />
    </FilterMenuPanel>,
    document.body,
  );
}

/**
 * The menu's frame: 264px wide, up to 340px tall, an optional search row
 * above the list. Fixed beside its chip; `inline` places it in the flow,
 * as the kit gallery does.
 */
export function FilterMenuPanel({
  ref,
  search,
  children,
  inline = false,
  wide = false,
  style,
  onKeyDown,
}: {
  ref?: RefObject<HTMLDivElement | null>;
  search?: ReactNode;
  children: ReactNode;
  inline?: boolean;
  /** 296px with no height cap, for a custom step's form. */
  wide?: boolean;
  style?: CSSProperties;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return (
    <div
      ref={ref}
      style={style}
      onKeyDown={onKeyDown}
      className={cn(
        "z-45 flex flex-col overflow-hidden rounded-xl border border-border bg-card text-sm shadow-menu motion-safe:animate-pop",
        wide ? "w-74" : "max-h-85 w-66",
        inline ? "relative" : "fixed",
      )}
    >
      {search ? (
        <label className="flex items-center gap-2 border-b border-hairline px-3 py-2.5 text-muted-foreground focus-within:shadow-[inset_0_-2px_0_var(--color-brand-700)]">
          <SearchIcon aria-hidden="true" className="size-4" />
          {search}
        </label>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The listbox: "Any …" first, the chosen option ticked, the highlighted one
 * coral 50 with coral 800 text and no border.
 */
export function FilterOptionList({
  ref,
  id,
  label,
  options,
  current,
  active,
  onChoose,
  onActivate,
}: {
  ref?: RefObject<HTMLUListElement | null>;
  id: string;
  label: string;
  /** "Any …" first, then the options, as the menu shows them. */
  options: readonly FilterOption[];
  current: string;
  active: number;
  onChoose: (value: string) => void;
  onActivate: (index: number) => void;
}): JSX.Element {
  return (
    <ul
      ref={ref}
      id={id}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={
        options.length ? `${id}-${String(active)}` : undefined
      }
      className="m-0 list-none overflow-y-auto p-1.5 focus:outline-none"
    >
      {options.length === 0 ? (
        <li className="px-2 py-2.5 text-muted-foreground">No matches</li>
      ) : (
        options.map((option, index) => {
          const selected = option.value === current;
          const highlighted = index === active;
          const OptionIcon = option.icon;
          return (
            <li
              key={option.value}
              id={`${id}-${String(index)}`}
              role="option"
              aria-selected={selected}
              data-active={highlighted || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(option.value)}
              onMouseMove={() => {
                if (!highlighted) onActivate(index);
              }}
              className={cn(
                "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5",
                highlighted && "bg-brand-50",
                selected && "font-(--w-ui)",
                option.value === ANY
                  ? "text-muted-foreground"
                  : selected
                    ? "text-foreground"
                    : highlighted
                      ? "text-brand-800"
                      : "text-secondary-foreground",
              )}
            >
              {option.mark ? (
                <EntityMark
                  name={option.label}
                  kind={option.mark === "person" ? "person" : "business"}
                  size="sm"
                />
              ) : null}
              {OptionIcon ? (
                <span className="inline-flex w-6 justify-center text-muted-foreground">
                  <OptionIcon aria-hidden="true" className="size-4" />
                </span>
              ) : null}
              {option.tone ? (
                <StatusBadge tone={option.tone}>{option.label}</StatusBadge>
              ) : (
                <span className="min-w-0">{option.label}</span>
              )}
              {selected ? (
                <CheckIcon
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 text-brand-700"
                />
              ) : null}
            </li>
          );
        })
      )}
    </ul>
  );
}

/** "Filter", shown before the chips when they sit on their own row. */
export function FilterLabel(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mr-1 hidden items-center gap-1.5 text-xs leading-4 font-(--w-ui) text-muted-foreground group-data-[stacked=true]/head:inline-flex"
    >
      <SlidersHorizontalIcon className="size-3.5" />
      Filter
    </span>
  );
}

/** Clears every filter but keeps the tab. */
export function ClearAllButton({
  onClick,
}: {
  onClick: () => void;
}): JSX.Element {
  return (
    <TextLinkButton
      onClick={onClick}
      className="order-first mr-1 ml-0 text-sm group-data-[stacked=true]/head:order-none group-data-[stacked=true]/head:mr-0 group-data-[stacked=true]/head:ml-auto"
    >
      Clear all
    </TextLinkButton>
  );
}
