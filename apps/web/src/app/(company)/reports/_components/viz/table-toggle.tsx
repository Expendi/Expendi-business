"use client";

import type { JSX, ReactNode } from "react";
import { Table2Icon } from "lucide-react";
import { useId, useState } from "react";

/**
 * "Show as table" under a chart: the same numbers as a table, for anyone
 * who can't or won't read the chart.
 */
export function TableToggle({
  children,
  defaultOpen = false,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="inline-flex items-center gap-1.5 rounded-[4px] border-0 bg-transparent px-0 py-1 text-xs leading-4 text-gray-600 hover:text-gray-900"
      >
        <Table2Icon aria-hidden="true" className="size-3.5" />
        {open ? "Hide table" : "Show as table"}
      </button>
      <div id={id} hidden={!open} className="overflow-x-auto">
        {children}
      </div>
    </div>
  );
}

/** The small table a chart's toggle shows: first column left, numbers right. */
export function MiniTable({
  caption,
  head,
  children,
}: {
  caption: string;
  head: readonly string[];
  children: ReactNode;
}): JSX.Element {
  return (
    <table className="mt-2 w-full border-collapse text-sm tabular-nums [&_td]:border-t [&_td]:border-hairline [&_td]:py-2 [&_td]:pl-3 [&_td]:text-right [&_td]:whitespace-nowrap [&_th]:py-2 [&_th]:pl-3 [&_th]:text-right [&_th]:whitespace-nowrap [&_th:first-child]:pl-0 [&_th:first-child]:text-left [&_tbody_th]:border-t [&_tbody_th]:border-hairline [&_tbody_th]:font-normal [&_tr[data-selected]]:font-(--w-ui)">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {head.map((label) => (
            <th
              key={label}
              scope="col"
              className="text-xs leading-4 font-normal text-gray-500"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
