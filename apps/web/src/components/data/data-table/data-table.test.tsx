import type { JSX } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { UseDataTableOptions } from "./use-data-table";
import type { DataTableColumnDef } from "~/lib/data-table-features";
import { DataTableColumnHeader } from "./column-header";
import { DataTable } from "./data-table";
import { DataTablePagination, rangeText } from "./pagination";
import { useDataTable } from "./use-data-table";

interface Payee {
  id: string;
  name: string;
  owed: number;
}

const PAYEES: Payee[] = [
  { id: "a", name: "Kilimani Properties", owed: 300 },
  { id: "b", name: "Zuku", owed: 100 },
  { id: "c", name: "Securex Guards", owed: 200 },
];

const COLUMNS: DataTableColumnDef<Payee>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Payee" />
    ),
    meta: { kind: "main" },
  },
  {
    id: "owed",
    accessorKey: "owed",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Owed" />
    ),
    meta: { align: "end" },
  },
  {
    id: "note",
    header: "Note",
    enableSorting: false,
    cell: () => "—",
  },
];

function Harness({
  options,
  loading,
}: {
  options: Partial<UseDataTableOptions<Payee>>;
  loading?: boolean;
}): JSX.Element {
  const table = useDataTable({
    data: PAYEES,
    columns: COLUMNS,
    getRowId: (payee) => payee.id,
    ...options,
  });
  return (
    <>
      <DataTable
        table={table}
        caption="Payees"
        loading={loading}
        empty="No payees yet."
      />
      <DataTablePagination table={table} noun="payees" />
    </>
  );
}

const render = (
  options: Partial<UseDataTableOptions<Payee>>,
  loading?: boolean,
) => renderToStaticMarkup(<Harness options={options} loading={loading} />);

const names = (html: string) =>
  PAYEES.map((payee) => ({ name: payee.name, at: html.indexOf(payee.name) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ name }) => name);

describe("DataTable", () => {
  it("sorts in the browser and marks the sorted header with aria-sort", () => {
    // #when
    const html = render({ sorting: { initial: [{ id: "owed", desc: true }] } });

    // #then
    expect({
      order: names(html),
      descending: html.includes('aria-sort="descending"'),
      unsorted: html.includes('aria-sort="none"'),
      unsortable: (html.match(/aria-sort=/g) ?? []).length,
      caption: html.includes(">Payees</caption>"),
    }).toEqual({
      order: ["Kilimani Properties", "Securex Guards", "Zuku"],
      descending: true,
      unsorted: true,
      unsortable: 2,
      caption: true,
    });
  });

  it("pages in the browser and says which rows show", () => {
    // #when
    const html = render({ pagination: { initialPageSize: 2 } });

    // #then
    expect({
      shown: names(html).length,
      range: html.includes("1–2 of 3"),
    }).toEqual({ shown: 2, range: true });
  });

  it("leaves a manual table's rows as the server sent them, counting rowCount", () => {
    // #when
    const html = render({
      manual: true,
      rowCount: 40,
      sorting: { initial: [{ id: "owed", desc: false }] },
      pagination: { initialPageSize: 2 },
    });

    // #then
    expect({ order: names(html), range: html.includes("1–2 of 40") }).toEqual({
      order: ["Kilimani Properties", "Zuku", "Securex Guards"],
      range: true,
    });
  });

  it("shows skeleton rows while loading and the empty message with no rows", () => {
    // #when
    const loading = render({}, true);
    const empty = render({ data: [] });

    // #then
    expect({
      busy: loading.includes('aria-busy="true"'),
      noNames: names(loading).length,
      empty: empty.includes("No payees yet."),
    }).toEqual({ busy: true, noNames: 0, empty: true });
  });
});

describe("rangeText", () => {
  it("counts from one and stops at the total", () => {
    // #then
    expect([
      rangeText({ pageIndex: 0, pageSize: 20, total: 0 }),
      rangeText({ pageIndex: 1, pageSize: 20, total: 34 }),
      rangeText({ pageIndex: 0, pageSize: 20, total: 1200 }),
    ]).toEqual(["0 of 0", "21–34 of 34", "1–20 of 1,200"]);
  });
});
