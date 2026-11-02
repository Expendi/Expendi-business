import { describe, expect, it } from "vitest";

import { formatNairobiDateTime } from "./nairobi-time";

describe("formatNairobiDateTime", () => {
  it("shows the time in Nairobi, three hours ahead of UTC", () => {
    // #given 21:30 UTC on 1 Nov is past midnight in Nairobi
    const isoDateTime = "2026-11-01T21:30:00.000000Z";

    // #when
    const shown = formatNairobiDateTime(isoDateTime);

    // #then
    expect(shown).toBe("2 Nov 2026, 00:30");
  });

  it("shows anything it can't read as it is", () => {
    // #when
    const shown = formatNairobiDateTime("not a time");

    // #then
    expect(shown).toBe("not a time");
  });
});
