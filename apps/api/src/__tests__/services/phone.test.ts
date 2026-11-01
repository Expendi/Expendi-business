import { describe, expect, it } from "vitest";

import { normalizeToE164 } from "../../services/auth/phone.js";

describe("normalizeToE164", () => {
  it.each([
    ["Safaricom 07xx", "0712345678", "+254712345678"],
    ["Airtel/Safaricom 01xx", "0112345678", "+254112345678"],
    ["spaced national", "0712 345 678", "+254712345678"],
    ["international with spaces", "+254 712 345 678", "+254712345678"],
    ["international without plus", "254712345678", "+254712345678"],
    ["already E.164", "+254712345678", "+254712345678"],
  ])("normalises %s", (_label, raw, expected) => {
    // #when
    const result = normalizeToE164(raw);

    // #then
    expect(result).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["too short", "07123"],
    ["letters", "call me maybe"],
  ])("returns null for %s input", (_label, raw) => {
    // #when
    const result = normalizeToE164(raw);

    // #then
    expect(result).toBeNull();
  });
});
