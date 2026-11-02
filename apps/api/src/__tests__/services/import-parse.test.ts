import { describe, expect, it } from "vitest";

import {
  importAmount,
  importDate,
  mappedRows,
  validateImportStatus,
} from "../../services/import/parse.js";

describe("spreadsheet values", () => {
  it("parses KES with integer arithmetic", () => {
    expect(importAmount("1,500.50")).toBe(150050n);
    expect(importAmount("90071992547409.93")).toBe(9007199254740993n);
    expect(importAmount("0", true)).toBe(0n);
  });
  it.each(["1,50", "1e3", "-1", "0", "12.345", "92233720368547758.08"])(
    "refuses ambiguous/out-of-range money: %s",
    (value) => expect(() => importAmount(value)).toThrow(),
  );
  it("uses day-first dates and validates actual calendar days", () => {
    expect(importDate("02/11/2026")).toBe("2026-11-02");
    expect(importDate("29/02/2024")).toBe("2024-02-29");
    expect(() => importDate("29/02/2026")).toThrow();
    expect(() => importDate("01/02/26")).toThrow();
  });
  it("enforces source payment status even if the Shanga Status column is unmapped", () => {
    const input = {
      kind: "history" as const,
      layout: "shanga" as const,
      fileName: "example.tsv",
      csv: "Expense Category\tItem Description\tDate Purchased\tCost\tVendor\tStatus\nOffice\tPaper\t02/11/2026\t100\tTest shop\tunpaid",
      mapping: { name: "Vendor" },
    };
    const row = mappedRows(input)[0];
    if (!row) throw new Error("Expected a source row");
    expect(row.status).toBe("unpaid");
    expect(() => validateImportStatus(input, row)).toThrow(/must be paid/);
    expect(() =>
      validateImportStatus({ ...input, kind: "bill" }, row),
    ).not.toThrow();
    expect(() => validateImportStatus(input, { ...row, $status: "" })).toThrow(
      /must be paid/,
    );
    expect(() =>
      validateImportStatus(
        { ...input, kind: "bill" },
        { ...row, $status: "pending" },
      ),
    ).toThrow(/must be unpaid/);
    expect(() => mappedRows({ ...input, kind: "recurring" })).toThrow(
      /separate prepared file/,
    );
  });
});
