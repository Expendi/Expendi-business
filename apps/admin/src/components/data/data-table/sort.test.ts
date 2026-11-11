import { describe, expect, it } from "vitest";

import { nextSort, pressedKey, sortFromTable, toSorting } from "./sort";

type Key = "date" | "amount" | "payee";
const KEYS: readonly Key[] = ["date", "amount", "payee"];

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

describe("toSorting", () => {
  it("turns a page sort into the table's sorting state", () => {
    // #then
    expect([
      toSorting<Key>({ key: "date", dir: "asc" }),
      toSorting<Key>({ key: "amount", dir: "desc" }),
    ]).toEqual([[{ id: "date", desc: false }], [{ id: "amount", desc: true }]]);
  });
});

describe("pressedKey", () => {
  const current = { key: "date", dir: "desc" } as const;

  it("names the pressed column, and the sorted one when the sort clears or is unknown", () => {
    // #then
    expect([
      pressedKey([{ id: "amount", desc: false }], current, KEYS),
      pressedKey([], current, KEYS),
      pressedKey([{ id: "select", desc: true }], current, KEYS),
    ]).toEqual(["amount", "date", "date"]);
  });
});

describe("sortFromTable", () => {
  const current = { key: "date", dir: "desc" } as const;

  it("takes the table's column and direction for a known key", () => {
    // #then
    expect([
      sortFromTable([{ id: "amount", desc: false }], current, KEYS),
      sortFromTable([{ id: "payee", desc: true }], current, KEYS),
    ]).toEqual([
      { key: "amount", dir: "asc" },
      { key: "payee", dir: "desc" },
    ]);
  });

  it("flips the current column when the sort clears or the key is unknown", () => {
    // #then
    expect([
      sortFromTable([], current, KEYS),
      sortFromTable([{ id: "select", desc: false }], current, KEYS),
      sortFromTable([], { key: "date", dir: "asc" }, KEYS),
    ]).toEqual([
      { key: "date", dir: "asc" },
      { key: "date", dir: "asc" },
      { key: "date", dir: "desc" },
    ]);
  });
});
