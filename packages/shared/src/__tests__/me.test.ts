import { describe, expect, it } from "vitest";

import { FULL_NAME_MAX_LENGTH, updateMeRequestSchema } from "../me.js";

const fullNameOf = (fullName: unknown) =>
  updateMeRequestSchema.safeParse({ fullName });

describe("updateMeRequestSchema", () => {
  it.each([
    ["Jane Wanjiku", "Jane Wanjiku"],
    ["  Jane   Wanjiku  ", "Jane Wanjiku"],
    ["Jane Wanjiku\n", "Jane Wanjiku"],
    ["Wanjiru O’Brien-Kamau", "Wanjiru O'Brien-Kamau"],
    ["Jean-Luc Mbappé", "Jean-Luc Mbappé"],
    ["Dr. Amina Yusuf", "Dr. Amina Yusuf"],
    ["Li", "Li"],
    ["ጀማል ሙሐመድ", "ጀማል ሙሐመድ"],
  ])("accepts %j as %j", (input, expected) => {
    // #when
    const parsed = fullNameOf(input);

    // #then
    expect(parsed.success && parsed.data.fullName).toBe(expected);
  });

  it.each([
    ["missing", undefined],
    ["not text", 42],
    ["empty", ""],
    ["only spaces", "    "],
    ["one letter", "J"],
    ["too long", "A".repeat(FULL_NAME_MAX_LENGTH + 1)],
    ["digits", "Jane 2"],
    ["symbols", "Jane <script>"],
    ["an emoji", "Jane 🙂"],
    ["a tab inside", "Jane\tWanjiku"],
    ["a line break inside", "Jane\nWanjiku"],
    ["a NUL character", "Jane\u0000Wanjiku"],
    ["a zero-width space", "Jane​Wanjiku"],
    ["a right-to-left override", "Jane‮ukijnaW"],
    ["a leading hyphen", "-Jane"],
  ])("refuses %s", (_label, input) => {
    // #when
    const parsed = fullNameOf(input);

    // #then
    expect(parsed.success).toBe(false);
  });

  it("accepts exactly the longest name", () => {
    // #when
    const parsed = fullNameOf("A".repeat(FULL_NAME_MAX_LENGTH));

    // #then
    expect(parsed.success).toBe(true);
  });

  it("words its errors for the person typing", () => {
    // #when
    const empty = fullNameOf("");
    const symbols = fullNameOf("Jane #1");

    // #then
    expect(empty.error?.issues[0]?.message).toBe("Enter your full name.");
    expect(symbols.error?.issues[0]?.message).toBe(
      "Use only letters, spaces, apostrophes, hyphens and full stops.",
    );
  });
});
