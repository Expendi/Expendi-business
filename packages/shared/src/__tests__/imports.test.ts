import { describe, expect, it } from "vitest";

import {
  companyImportRequestSchema,
  parseImportCsv,
  parseImportSpreadsheet,
  suggestImportMapping,
} from "../imports.js";

describe("CSV import", () => {
  it("limits self-service imports to paid expenses and unpaid bills", () => {
    const base = {
      fileName: "example.csv",
      csv: "name\nShop",
      mapping: { name: "name" },
    };
    for (const kind of ["history", "bill"])
      expect(
        companyImportRequestSchema.safeParse({ ...base, kind }).success,
      ).toBe(true);
    for (const kind of ["claim", "salary", "recurring", "float", "payee"])
      expect(
        companyImportRequestSchema.safeParse({ ...base, kind }).success,
      ).toBe(false);
    expect(
      companyImportRequestSchema.safeParse({
        ...base,
        kind: "history",
        mapping: { email: "name" },
      }).success,
    ).toBe(false);
  });
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
  it("detects TSV without splitting commas in amounts, and respects quoted tabs", () => {
    expect(
      parseImportCsv('name\tamount\tnote\r\nShop\t1,500.50\t"a\tb"'),
    ).toEqual({
      headers: ["name", "amount", "note"],
      rows: [["Shop", "1,500.50", "a\tb"]],
    });
    expect(parseImportCsv('"a\tb",amount\nShop,12').headers).toEqual([
      "a\tb",
      "amount",
    ]);
  });
  const header =
    "Expense Category\tItem Description\tPurchased By\tDate Purchased\tCost\tVendor\tStatus\t\t";
  it("cleans Shanga template rows, keeps source line numbers and all transaction cells", () => {
    const parsed = parseImportSpreadsheet(
      [
        header,
        "",
        header,
        'Office\t"Paper\nA4"\tAlex\t02/11/2026\t1,500.50\tTest Shop\tpaid\t\tref-1',
        "\t\t\t\t\t\t\t10941-\t",
        "Column 1\tColumn 2\tColumn 3\tColumn 4\tColumn 5\tColumn 6\tColumn 7\t\t",
      ].join("\n"),
      "shanga",
    );
    expect(parsed.rowNumbers).toEqual([4]);
    expect(parsed.rows[0]).toEqual([
      "Office",
      "Paper\nA4",
      "Alex",
      "02/11/2026",
      "1,500.50",
      "Test Shop",
      "paid",
      "",
      "ref-1",
    ]);
    expect(parsed.ignored.map((r) => r.row)).toEqual([3, 6, 7]);
    expect(parsed.headers.at(-1)).toBe("Unnamed column 9");
  });
  it("does not drop an incomplete transaction or a subtotal inside named columns", () => {
    const parsed = parseImportSpreadsheet(
      `${header}\nOffice\t\t\t\t\t\t\t\t\nTotal\t\t\t\t100\t\t\t\t`,
      "shanga",
    );
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.ignored).toEqual([]);
  });
  it("rejects empty templates and income instead of manufacturing expenses", () => {
    expect(() =>
      parseImportSpreadsheet(
        `${header}\n\n${header}\n\t\t\t\t\t\t\t10941\t`,
        "shanga",
      ),
    ).toThrow(/No transaction rows/);
    expect(() =>
      parseImportSpreadsheet("Income Category\tAmount\nSales\t100", "shanga"),
    ).toThrow(/income/);
  });
  it("suggests columns without guessing totals, membership or bill due dates", () => {
    const headers = [
      "Vendor",
      "Purchased By",
      "Date Purchased",
      "Cost",
      "Total",
      "Expense Category",
      "Status",
    ];
    const history = suggestImportMapping(headers, "history");
    expect(history.name).toBe("Vendor");
    expect(history.date).toBe("Date Purchased");
    expect(history.email).toBeUndefined();
    expect(history.amount).toBeUndefined();
    expect(suggestImportMapping(headers, "bill").date).toBeUndefined();
  });
});
