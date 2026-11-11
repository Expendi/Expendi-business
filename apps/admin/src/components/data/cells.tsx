"use client";

import type { LucideIcon } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { cn } from "cn";

/** Whether a click landed on a row's own button, link or field. */
export function isInsideControl(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest("button, input, label, a, select, textarea") !== null
  );
}

/** The name a row is about, 16/24 at 600; a button when it opens the sheet. */
export function RowTitle({
  children,
  onOpen,
}: {
  children: ReactNode;
  onOpen?: () => void;
}): JSX.Element {
  const className =
    "block rounded-[4px] text-left text-base leading-6 font-(--w-name) text-foreground";
  if (!onOpen) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cn(
        className,
        "border-0 bg-transparent p-0 hover:underline hover:decoration-border hover:underline-offset-3",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A row's second line: muted text that truncates, then small markers, so
 * every row stays two lines tall.
 */
export function RowMeta({
  text,
  children,
}: {
  text?: string | null;
  children?: ReactNode;
}): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
      {text ? (
        <span className="min-w-0 truncate" title={text}>
          {text}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/**
 * A small inline marker after a row's meta text, e.g. a recurring icon, or
 * a paperclip and "2". `label` is the full meaning ("2 files"), read out and
 * shown on hover; `children` is what shows beside the icon.
 */
export function Mini({
  icon: Icon,
  label,
  children,
  warn = false,
}: {
  icon: LucideIcon;
  label: string;
  children?: ReactNode;
  warn?: boolean;
}): JSX.Element {
  return (
    <span
      title={label}
      className={cn(
        "inline-flex flex-none items-center gap-1 text-xs leading-4 whitespace-nowrap tabular-nums",
        warn ? "text-warn-700" : "text-muted-foreground",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          warn ? "text-warn-700" : "text-muted-foreground/70",
        )}
      />
      {children === undefined ? null : (
        <span aria-hidden="true">{children}</span>
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The custom checkbox: gray-500 border, brand-700 with a white tick when
 * checked. A row that can't be selected gets no checkbox at all.
 */
export function RowCheckbox({
  className,
  ...props
}: Omit<ComponentProps<"input">, "type">): JSX.Element {
  return (
    <input
      type="checkbox"
      className={cn(
        "m-0 inline-grid size-[18px] flex-none cursor-pointer appearance-none place-content-center rounded-[4px] border border-muted-foreground bg-card transition-[background-color,border-color] duration-150 before:size-3 before:scale-0 before:bg-(image:--check-tick) before:bg-contain before:bg-center before:bg-no-repeat before:transition-transform before:duration-[120ms] before:ease-out-expo before:content-[''] checked:border-brand-700 checked:bg-brand-700 checked:before:scale-100 hover:not-disabled:not-checked:border-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) disabled:cursor-not-allowed disabled:border-input disabled:bg-muted checked:disabled:border-muted-foreground/50 checked:disabled:bg-muted-foreground/50 motion-reduce:transition-none motion-reduce:before:transition-none",
        className,
      )}
      {...props}
    />
  );
}

/** A business or a person, as initials: square for businesses, round for people. */
export function EntityMark({
  name,
  kind = "business",
  size = "md",
}: {
  name: string;
  kind?: "business" | "person";
  size?: "sm" | "md";
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center font-(--w-strong) tracking-[0.02em] text-secondary-foreground",
        size === "md" ? "size-8 text-xs" : "size-6 text-[11px]",
        kind === "business"
          ? "rounded-control border border-border bg-card"
          : "rounded-full bg-muted",
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** "Kilimani Properties" → "KP"; "Zuku" → "ZU". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/);
  const [first = "", second] = words;
  return (
    second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2)
  ).toUpperCase();
}

export function PhoneCard({
  mark,
  title,
  sub,
  flags,
  aside,
  onOpen,
  check,
  selected = false,
}: {
  mark?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** Status badge and markers, under the sub line. */
  flags?: ReactNode;
  /** Usually the amount. */
  aside?: ReactNode;
  onOpen: () => void;
  /** A `RowCheckbox`, when the row can be selected. */
  check?: ReactNode;
  selected?: boolean;
}): JSX.Element {
  return (
    <li
      className={cn(
        "flex items-start border-b border-border",
        selected && "bg-accent",
      )}
    >
      {check ? (
        <span className="box-border w-[34px] flex-none pt-5 pl-4">{check}</span>
      ) : null}
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className={cn(
          "grid w-full items-start gap-3 border-0 bg-transparent px-4 py-3.5 text-left focus-visible:-outline-offset-2",
          mark
            ? "grid-cols-[32px_minmax(0,1fr)_auto]"
            : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        {mark}
        <span className="min-w-0">
          <span className="block truncate text-base leading-6 font-(--w-name) text-foreground">
            {title}
          </span>
          {sub ? (
            <span className="block truncate text-muted-foreground tabular-nums">
              {sub}
            </span>
          ) : null}
          {flags ? (
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              {flags}
            </span>
          ) : null}
        </span>
        {aside}
      </button>
    </li>
  );
}
