import { describe, expect, it } from "vitest";

import { initialsOf } from "./initials";

describe("initialsOf", () => {
  it.each([
    ["Achieng' Odhiambo", "AO"],
    ["Wanjiru Kamau", "WK"],
    ["brian", "B"],
    ["  Faith   Wairimu Njeri ", "FN"],
    ["Mawingu Labs Ltd", "ML"],
    ["", ""],
  ])("turns %j into %j", (name, expected) => {
    // #when
    const initials = initialsOf(name);

    // #then
    expect(initials).toBe(expected);
  });
});
