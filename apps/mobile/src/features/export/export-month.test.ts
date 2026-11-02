import { describe, expect, it } from "vitest";

import type { GeneratedExport } from "@expendi-business/shared";
import { generatedExportSchema } from "@expendi-business/shared";

import {
  expiryLabel,
  monthLabel,
  nairobiMonth,
  shareMessage,
  shiftMonth,
} from "./export-month";

const EXPORTED: GeneratedExport = {
  id: "11111111-1111-4111-8111-111111111111",
  month: "2026-10",
  monthly: false,
  createdBy: "Jane Wanjiku",
  createdAt: "2026-11-02T07:00:00.000Z",
  expiresAt: "2026-12-02T07:00:00.000Z",
  links: {
    workbook: "https://api.expendi.app/downloads/reports/abc/workbook",
    csv: "https://api.expendi.app/downloads/reports/abc/csv",
    receipts: "https://api.expendi.app/downloads/reports/abc/receipts",
  },
};

describe("export months", () => {
  it("takes the month from Nairobi's clock, not the phone's UTC date", () => {
    // #then
    expect(nairobiMonth(new Date("2026-10-31T20:59:59Z"))).toBe("2026-10");
    expect(nairobiMonth(new Date("2026-10-31T21:00:00Z"))).toBe("2026-11");
  });

  it("steps across years", () => {
    // #then
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("names months and expiry days for people", () => {
    // #then
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(expiryLabel("2026-11-30T21:00:00.000Z")).toBe("1 December 2026");
  });
});

describe("sharing an export", () => {
  it("lists the three links and when they stop working", () => {
    // #given
    expect(generatedExportSchema.parse(EXPORTED)).toEqual(EXPORTED);

    // #when
    const message = shareMessage("Acme Kenya Ltd", EXPORTED);

    // #then
    expect(message).toBe(
      [
        "Acme Kenya Ltd: October 2026 export",
        "Spreadsheet (Excel): https://api.expendi.app/downloads/reports/abc/workbook",
        "Spreadsheet (CSV files): https://api.expendi.app/downloads/reports/abc/csv",
        "Receipts (zip): https://api.expendi.app/downloads/reports/abc/receipts",
        "These links work until 2 December 2026.",
      ].join("\n\n"),
    );
  });
});
