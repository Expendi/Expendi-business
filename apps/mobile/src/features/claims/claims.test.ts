import { describe, expect, it } from "vitest";

import { formatIsoDate, localIsoDate } from "./dates";
import { receiptResize, toHex } from "./receipt-image";

describe("receiptResize", () => {
  it.each([
    [{ width: 4032, height: 3024 }, { width: 1600 }],
    [{ width: 3024, height: 4032 }, { height: 1600 }],
    [{ width: 2000, height: 2000 }, { width: 1600 }],
    [{ width: 1600, height: 900 }, null],
    [{ width: 720, height: 1280 }, null],
  ])("shrinks %j by %j", (size, expected) => {
    // #when
    const resize = receiptResize(size);

    // #then
    expect(resize).toEqual(expected);
  });
});

describe("toHex", () => {
  it("writes each byte as two lowercase hex digits", () => {
    // #given
    const bytes = new Uint8Array([0, 15, 16, 255]);

    // #when
    const hex = toHex(bytes.buffer);

    // #then
    expect(hex).toBe("000f10ff");
  });
});

describe("localIsoDate", () => {
  it("pads the month and day", () => {
    // #given
    const date = new Date(2026, 0, 5, 23, 59);

    // #when
    const isoDate = localIsoDate(date);

    // #then
    expect(isoDate).toBe("2026-01-05");
  });
});

describe("formatIsoDate", () => {
  it.each([
    ["2026-10-15", "15 Oct 2026"],
    ["2026-01-01", "1 Jan 2026"],
    ["2026-13-01", "2026-13-01"],
    ["yesterday", "yesterday"],
  ])("shows %s as %s", (isoDate, expected) => {
    // #when
    const formatted = formatIsoDate(isoDate);

    // #then
    expect(formatted).toBe(expected);
  });
});
