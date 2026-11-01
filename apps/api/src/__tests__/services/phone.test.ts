import { describe, expect, it } from "vitest";

import { normalizeToE164, toKenyanMobile } from "../../services/auth/phone.js";

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

describe("toKenyanMobile", () => {
  it.each([
    ["07xx", "0712345678", "+254712345678"],
    ["01xx", "0112345678", "+254112345678"],
    ["+2547xx", "+254712345678", "+254712345678"],
    ["+2541xx", "+254112345678", "+254112345678"],
    ["2547xx without the plus", "254712345678", "+254712345678"],
    ["spaced and dashed", " 0712-345 678 ", "+254712345678"],
  ])("normalises %s to E.164", (_label, raw, expected) => {
    // #when
    const result = toKenyanMobile(raw);

    // #then
    expect(result).toBe(expected);
  });

  it.each([
    ["a US number", "+14155552671"],
    ["a UK mobile", "+447700900123"],
    ["a Ugandan mobile", "+256712345678"],
    ["a Tanzanian mobile", "+255712345678"],
    ["a Nairobi landline", "0202222222"],
    ["a Kenyan number one digit short", "071234567"],
    ["empty", ""],
    ["letters", "call me maybe"],
  ])("rejects %s", (_label, raw) => {
    // #when
    const result = toKenyanMobile(raw);

    // #then
    expect(result).toBeNull();
  });
});
