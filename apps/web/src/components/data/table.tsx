"use client";

import type { LucideIcon } from "lucide-react";
import type {
  ComponentProps,
  JSX,
  MouseEvent,
  ReactNode,
  ThHTMLAttributes,
} from "react";
import { cn } from "cn";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";

import { Skel } from "./states";

/**
 * The results table: one flat list, sortable headers, two-line rows. Under
 * a 720px results panel (or a 900px window) it gives way to `PhoneCards`.
 * Put it inside `ResultsPanel`, whose container query drives the switch.
 */
export function DataTable({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="overflow-x-auto max-[900px]:hidden @max-[720px]/results:hidden">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/**
 * `md` columns hide under a 900px panel and `lg` ones under 960px, the
 * least important first (e.g. eTIMS, then the payment method).
 */
export type ColumnCollapse = "md" | "lg";

const COLLAPSE: Record<ColumnCollapse, string> = {
  md: "@max-[900px]/results:hidden",
  lg: "@max-[960px]/results:hidden",
};

const thClass =
  "border-b border-gray-200 bg-gray-25 px-4 py-2.5 text-left text-xs leading-4 font-(--w-ui) whitespace-nowrap text-gray-500";

export function Th({
  align = "start",
  collapse,
  checkbox = false,
  className,
  children,
  ...props
}: Omit<ThHTMLAttributes<HTMLTableCellElement>, "align"> & {
  align?: "start" | "end";
  collapse?: ColumnCollapse;
  /** The narrow column of row checkboxes. */
  checkbox?: boolean;
}): JSX.Element {
  return (
    <th
      scope="col"
      className={cn(
        thClass,
        align === "end" && "text-right",
        collapse && COLLAPSE[collapse],
        checkbox && "w-12 pr-0",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export type SortDirection = "asc" | "desc";

export interface SortState<K extends string> {
  readonly key: K;
  readonly dir: SortDirection;
}

/**
 * The sort after a header is pressed: the same column flips; another
 * column starts in its own natural direction (e.g. amounts high to low).
 */
export function nextSort<K extends string>(
  current: SortState<K>,
  key: K,
  firstDir: SortDirection,
): SortState<K> {
  if (current.key !== key) return { key, dir: firstDir };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

export function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align = "start",
  collapse,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "start" | "end";
  collapse?: ColumnCollapse;
}): JSX.Element {
  const active = sort.key === sortKey;
  const Icon = !active
    ? ArrowUpDownIcon
    : sort.dir === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon;
  return (
    <Th
      align={align}
      collapse={collapse}
      aria-sort={
        active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "group/sort inline-flex items-center gap-1 rounded-[4px] border-0 bg-transparent p-0 [font:inherit]",
          active ? "text-gray-900" : "text-inherit hover:text-gray-900",
        )}
      >
        {label}
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3 transition-colors duration-150",
            active
              ? "text-gray-900"
              : "text-gray-400 group-hover/sort:text-gray-600",
          )}
        />
      </button>
    </Th>
  );
}

function isInsideControl(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest("button, input, label, a, select, textarea") !== null
  );
}

/**
 * A clickable row. Clicks on its own buttons, links and checkboxes stay
 * theirs; anywhere else opens the row. The row's name button is the
 * keyboard way in.
 */
export function DataRow({
  open = false,
  selected = false,
  onOpen,
  children,
}: {
  /** Its details are in the side sheet now. */
  open?: boolean;
  selected?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}): JSX.Element {
  function onClick(event: MouseEvent<HTMLTableRowElement>) {
    if (onOpen && !isInsideControl(event.target)) onOpen();
  }
  return (
    <tr
      data-open={open || undefined}
      data-selected={selected || undefined}
      onClick={onClick}
      className={cn(
        "transition-colors duration-150",
        onOpen && "cursor-pointer",
        selected
          ? "bg-brand-50"
          : open
            ? "bg-gray-50 shadow-[inset_3px_0_0_var(--color-gray-900)]"
            : "hover:bg-gray-25",
      )}
    >
      {children}
    </tr>
  );
}

export function Td({
  kind = "plain",
  align = "start",
  collapse,
  className,
  children,
  ...props
}: Omit<ComponentProps<"td">, "align"> & {
  /**
   * main: the column that takes the spare width and truncates its second
   * line; date: muted and unwrapped; checkbox: the narrow select column.
   */
  kind?: "plain" | "main" | "date" | "checkbox";
  align?: "start" | "end";
  collapse?: ColumnCollapse;
}): JSX.Element {
  return (
    <td
      className={cn(
        "border-b border-row-divider px-4 py-3 align-top",
        kind === "main" && "w-full max-w-0",
        kind === "date" && "whitespace-nowrap text-gray-600 tabular-nums",
        kind === "checkbox" && "w-12 pt-[18px] pr-0",
        align === "end" && "text-right",
        collapse && COLLAPSE[collapse],
        className,
      )}
      {...props}
    >
      {children}
    </td>
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
    "block rounded-[4px] text-left text-base leading-6 font-(--w-name) text-gray-900";
  if (!onOpen) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cn(
        className,
        "border-0 bg-transparent p-0 hover:underline hover:decoration-gray-300 hover:underline-offset-3",
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
    <span className="flex min-w-0 items-center gap-2 text-gray-500">
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
        warn ? "text-warn-700" : "text-gray-500",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5", warn ? "text-warn-700" : "text-gray-400")}
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
        "m-0 inline-grid size-[18px] flex-none cursor-pointer appearance-none place-content-center rounded-[4px] border border-gray-500 bg-surface transition-[background-color,border-color] duration-150 before:size-3 before:scale-0 before:bg-(image:--check-tick) before:bg-contain before:bg-center before:bg-no-repeat before:transition-transform before:duration-[120ms] before:ease-out-expo before:content-[''] checked:border-brand-700 checked:bg-brand-700 checked:before:scale-100 hover:not-disabled:not-checked:border-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) disabled:cursor-not-allowed disabled:border-gray-300 disabled:bg-gray-100 checked:disabled:border-gray-400 checked:disabled:bg-gray-400 motion-reduce:transition-none motion-reduce:before:transition-none",
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
        "inline-flex flex-none items-center justify-center font-(--w-strong) tracking-[0.02em] text-gray-700",
        size === "md" ? "size-8 text-xs" : "size-6 text-[11px]",
        kind === "business"
          ? "rounded-control border border-gray-200 bg-surface"
          : "rounded-full bg-gray-100",
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

/** The phone layout of the same rows; shown where the table hides. */
export function PhoneCards({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <ul
      aria-label={label}
      className="m-0 hidden list-none p-0 max-[900px]:block @max-[720px]/results:block"
    >
      {children}
    </ul>
  );
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
        "flex items-start border-b border-row-divider",
        selected && "bg-brand-50",
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
          <span className="block truncate text-base leading-6 font-(--w-name) text-gray-900">
            {title}
          </span>
          {sub ? (
            <span className="block truncate text-gray-500 tabular-nums">
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

/**
 * Loading rows in the table's shape: a date, a two-line name, middle
 * columns, and the amount at the end.
 */
export function TableSkeletonRows({
  rows = 6,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}): JSX.Element {
  const middle = Math.max(0, columns - 3);
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden="true">
          <td className="border-b border-row-divider p-4">
            <Skel width={80} height={14} />
          </td>
          <td className="w-full max-w-0 border-b border-row-divider p-4">
            <Skel width="55%" height={14} />
            <Skel width="35%" height={12} style={{ marginTop: 8 }} />
          </td>
          {Array.from({ length: middle }, (_, column) => (
            <td key={column} className="border-b border-row-divider p-4">
              <Skel width={100} height={14} />
            </td>
          ))}
          <td className="border-b border-row-divider p-4">
            <Skel width={90} height={14} style={{ marginLeft: "auto" }} />
          </td>
        </tr>
      ))}
    </>
  );
}
