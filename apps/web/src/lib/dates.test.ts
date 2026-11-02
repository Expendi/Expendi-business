import { describe, expect, it } from "vitest";

import { formatIsoDate, formatNairobiDate } from "./dates";

describe("dates", () => {
  it("formats a calendar day", () => {
    // #then
    expect(formatIsoDate("2026-10-05")).toBe("5 Oct 2026");
  });

  it("puts a moment on its Nairobi day, three hours ahead of UTC", () => {
    // #when
    const day = formatNairobiDate("2026-10-31T21:30:00.000Z");

    // #then
    expect(day).toBe("1 Nov 2026");
  });
});
