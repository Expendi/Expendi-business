import { describe, expect, it } from "vitest";

import { parseImportCsv } from "../imports.js";

describe("CSV import", () => {
  it("reads BOM, CRLF, quoted commas/newlines and escaped quotes", () => {
    expect(
      parseImportCsv(
        '\uFEFFname,amount,note\r\n"Shop, Nairobi","1,500.00","line 1\n""quoted"""\r\n',
      ),
    ).toEqual({
      headers: ["name", "amount", "note"],
      rows: [["Shop, Nairobi", "1,500.00", 'line 1\n"quoted"']],
    });
  });
  it.each(["a,a\n1,2", "a,b\n1", 'a\n"broken', 'a\n"x"oops', 'a\nx"y'])(
    "rejects malformed input: %s",
    (csv) => {
      expect(() => parseImportCsv(csv)).toThrow();
    },
  );
  it("bounds files and rows", () => {
    expect(() => parseImportCsv("a\n" + "x\n".repeat(501))).toThrow(/500/);
    expect(() => parseImportCsv("a\n" + "x".repeat(512001))).toThrow(/512/);
  });
});
