import { ClockIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FilterOption } from "./filter-chip";
import { FilterChip, FilterOptionList } from "./filter-chip";

const STATUSES: readonly FilterOption[] = [
  { value: "overdue", label: "Overdue", tone: "overdue" },
  { value: "due", label: "Due today", tone: "waiting" },
  { value: "upcoming", label: "Upcoming", tone: "quiet" },
];

const noop = () => undefined;

function chip(value: string | null): string {
  return renderToStaticMarkup(
    <FilterChip
      label="Status"
      icon={ClockIcon}
      options={STATUSES}
      value={value}
      onChange={noop}
      anyLabel="Any status"
    />,
  );
}

function list(current: string, active: number): string {
  return renderToStaticMarkup(
    <FilterOptionList
      id="status"
      label="Status"
      options={[{ value: "", label: "Any status" }, ...STATUSES]}
      current={current}
      active={active}
      onChoose={noop}
      onActivate={noop}
    />,
  );
}

const options = (html: string) =>
  [...html.matchAll(/<li[^>]*role="option"[^>]*>(.*?)<\/li>/g)].map(
    ([, inner]) => inner ?? "",
  );

describe("FilterChip", () => {
  it("is a dashed chip with its label and a chevron while empty", () => {
    // #when
    const html = chip(null);

    // #then
    expect({
      label: html.includes('aria-label="Filter by status"'),
      dashed: html.includes("border-dashed"),
      chevron: html.includes("lucide-chevron-down"),
      listbox: html.includes('aria-haspopup="listbox"'),
      remove: html.includes("Remove the status filter"),
    }).toEqual({
      label: true,
      dashed: true,
      chevron: true,
      listbox: true,
      remove: false,
    });
  });

  it("shows Label: value in coral with a remove button once set", () => {
    // #when
    const html = chip("due");

    // #then
    expect({
      label: html.includes('aria-label="Status: Due today. Change"'),
      key: html.includes(">Status:</span>"),
      value: html.includes(">Due today</span>"),
      coral: html.includes("bg-brand-50"),
      dashed: html.includes("border-dashed"),
      remove: html.includes('aria-label="Remove the status filter"'),
    }).toEqual({
      label: true,
      key: true,
      value: true,
      coral: true,
      dashed: false,
      remove: true,
    });
  });
});

describe("FilterOptionList", () => {
  it("lists Any first, then each status as a badge, ticking the chosen one", () => {
    // #when
    const html = list("due", 0);
    const shown = options(html);

    // #then
    expect({
      count: shown.length,
      any: shown[0]?.includes("Any status") && !shown[0].includes("data-tone"),
      badges: shown
        .slice(1)
        .map((inner) => /data-tone="([^"]+)"/.exec(inner)?.[1]),
      ticked: shown.map((inner) => inner.includes("lucide-check")),
      selected: (html.match(/aria-selected="true"/g) ?? []).length,
    }).toEqual({
      count: 4,
      any: true,
      badges: ["overdue", "waiting", "quiet"],
      ticked: [false, false, true, false],
      selected: 1,
    });
  });

  it("highlights the active option in coral 50 with coral 800 text and no border", () => {
    // #when
    const html = list("", 1);
    const active = /<li[^>]*data-active="true"[^>]*>/.exec(html)?.[0] ?? "";

    // #then
    expect({
      descendant: html.includes('aria-activedescendant="status-1"'),
      tint: active.includes("bg-brand-50"),
      text: active.includes("text-brand-800"),
      border: /\bborder\b/.test(active),
    }).toEqual({ descendant: true, tint: true, text: true, border: false });
  });

  it("says so when the search matches nothing", () => {
    // #when
    const html = renderToStaticMarkup(
      <FilterOptionList
        id="payee"
        label="Payee"
        options={[]}
        current=""
        active={0}
        onChoose={noop}
        onActivate={noop}
      />,
    );

    // #then
    expect({
      empty: html.includes("No matches"),
      descendant: html.includes("aria-activedescendant"),
    }).toEqual({ empty: true, descendant: false });
  });
});
