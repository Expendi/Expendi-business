import { describe, expect, it } from "vitest";

import { initialsOf } from "./cells";

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
