import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initialsOf, nextSort, SortHeader } from "./table";

describe("nextSort", () => {
  it("flips the same column and starts another in its own direction", () => {
    // #when
    const sorts = [
      nextSort({ key: "date", dir: "asc" }, "date", "asc"),
      nextSort({ key: "date", dir: "asc" }, "amount", "desc"),
    ];

    // #then
    expect(sorts).toEqual([
      { key: "date", dir: "desc" },
      { key: "amount", dir: "desc" },
    ]);
  });
});

describe("SortHeader", () => {
  it("marks the sorted column with aria-sort and an arrow, the others with none", () => {
    // #when
    const html = renderToStaticMarkup(
      <table>
        <thead>
          <tr>
            <SortHeader
              label="Due"
              sortKey="date"
              sort={{ key: "date", dir: "desc" }}
              onSort={() => undefined}
            />
            <SortHeader
              label="Payee"
              sortKey="payee"
              sort={{ key: "date", dir: "desc" }}
              onSort={() => undefined}
            />
          </tr>
        </thead>
      </table>,
    );

    // #then
    expect({
      sorted: html.includes('aria-sort="descending"'),
      unsorted: html.includes('aria-sort="none"'),
      down: html.includes("lucide-arrow-down "),
      both: html.includes("lucide-arrow-up-down"),
    }).toEqual({ sorted: true, unsorted: true, down: true, both: true });
  });
});

describe("initialsOf", () => {
  it("takes two words' first letters, or a single word's first two", () => {
    // #then
    expect([
      initialsOf("Kilimani Properties"),
      initialsOf("Zuku"),
      initialsOf("  wanjiru kamau "),
    ]).toEqual(["KP", "ZU", "WK"]);
  });
});
