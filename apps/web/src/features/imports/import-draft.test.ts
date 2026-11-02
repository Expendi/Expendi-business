import { describe, expect, it } from "vitest";

import {
  companyImportRequestSchema,
  parseImportCsv,
} from "@expendi-business/shared";

import { importTemplate, suggestCompanyMapping } from "./import-draft";

describe("customer import preparation", () => {
  it("matches custom columns without mistaking a purchase date for a bill due date", () => {
    const headers = [
      "Supplier Name",
      "Value",
      "Date Purchased",
      "Expense Category",
      "Status",
    ];
    expect(suggestCompanyMapping(headers, "history")).toMatchObject({
      name: "Supplier Name",
      amount: "Value",
      date: "Date Purchased",
      category: "Expense Category",
      status: "Status",
    });
    expect(suggestCompanyMapping(headers, "bill")).toMatchObject({
      payee: "Supplier Name",
      amount: "Value",
    });
    expect(suggestCompanyMapping(headers, "bill").date).toBeUndefined();
  });
  it("leaves Shanga totals and personnel unit costs for explicit review", () => {
    expect(
      suggestCompanyMapping(["Cost", "Total"], "history").amount,
    ).toBeUndefined();
    expect(
      suggestCompanyMapping(["Cost", "Column 8"], "history").amount,
    ).toBeUndefined();
  });
  it.each(["history", "bill"] as const)(
    "downloads a parseable %s example with compatible mappings and a distinct reference",
    (kind) => {
      const csv = importTemplate(kind);
      const { headers, rows } = parseImportCsv(csv);
      expect(rows).toHaveLength(1);
      expect(headers).toContain("reference");
      const input = {
        kind,
        csv,
        fileName: "example.csv",
        mapping: suggestCompanyMapping(headers, kind),
      };
      expect(companyImportRequestSchema.safeParse(input).success).toBe(true);
      expect(input.mapping).toMatchObject({
        amount: "amount",
        date: "date",
        category: "category",
        status: "status",
      });
    },
  );
});
