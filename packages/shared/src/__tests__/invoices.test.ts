import { describe, expect, it } from "vitest";

import {
  customerInputSchema,
  dueOnFor,
  invoiceDraftInputSchema,
  invoiceLineInputSchema,
  invoiceMarkPaidSchema,
  lineAmountCents,
  quantityToMilli,
  suggestNextInvoiceNumber,
} from "../invoices.js";

const CUSTOMER_ID = "0b1c9b52-4f3e-4a0c-9d3a-6a4d4b0f7e11";

const draft = {
  customerId: CUSTOMER_ID,
  number: "INV-0001",
  issueOn: "2026-11-02",
  lines: [{ description: "Design", quantity: "1", unitPriceCents: "150000" }],
};

describe("suggestNextInvoiceNumber", () => {
  it("starts at INV-0001", () => {
    expect(suggestNextInvoiceNumber([])).toBe("INV-0001");
  });

  it("takes the highest trailing number across all formats", () => {
    expect(
      suggestNextInvoiceNumber(["INV-0009", "2026/0012", "ACME-3", "draft"]),
    ).toBe("INV-0013");
  });

  it("grows past four digits", () => {
    expect(suggestNextInvoiceNumber(["INV-9999"])).toBe("INV-10000");
  });
});

describe("dueOnFor", () => {
  it.each([
    ["on_receipt", "2026-11-02"],
    ["net_15", "2026-11-17"],
    ["net_30", "2026-12-02"],
  ] as const)("%s", (terms, expected) => {
    expect(dueOnFor("2026-11-02", terms)).toBe(expected);
  });

  it("crosses a year end", () => {
    expect(dueOnFor("2026-12-20", "net_30")).toBe("2027-01-19");
  });

  it("uses the chosen date for custom terms", () => {
    expect(dueOnFor("2026-11-02", "custom", "2027-02-01")).toBe("2027-02-01");
  });
});

describe("lineAmountCents", () => {
  it("rounds half up to the cent", () => {
    expect(lineAmountCents("0.5", 1n)).toBe(1n);
    expect(lineAmountCents("0.499", 1n)).toBe(0n);
    expect(lineAmountCents("2.5", 333n)).toBe(833n);
  });

  it("reads quantity in thousandths", () => {
    expect(quantityToMilli("1.5")).toBe(1500n);
    expect(quantityToMilli("1.5555")).toBeNull();
  });
});

describe("invoiceLineInputSchema", () => {
  const line = { description: "Hours", quantity: "1", unitPriceCents: "100" };

  it.each(["0", "0.000", "-1", "1.2345", "", "1e3", " 1"])(
    "rejects quantity %j",
    (quantity) => {
      expect(
        invoiceLineInputSchema.safeParse({ ...line, quantity }).success,
      ).toBe(false);
    },
  );

  it("rejects a decimal or negative price", () => {
    expect(
      invoiceLineInputSchema.safeParse({ ...line, unitPriceCents: "1.5" })
        .success,
    ).toBe(false);
    expect(
      invoiceLineInputSchema.safeParse({ ...line, unitPriceCents: "-1" })
        .success,
    ).toBe(false);
  });

  it("accepts a free line", () => {
    expect(
      invoiceLineInputSchema.safeParse({ ...line, unitPriceCents: "0" })
        .success,
    ).toBe(true);
  });

  it("rejects a line too large to store", () => {
    expect(
      invoiceLineInputSchema.safeParse({
        ...line,
        quantity: "999999999999",
        unitPriceCents: "999999999999999",
      }).success,
    ).toBe(false);
  });
});

describe("invoiceDraftInputSchema", () => {
  it("defaults terms to net 30 and the tax label to VAT", () => {
    const parsed = invoiceDraftInputSchema.parse(draft);
    expect(parsed.terms).toBe("net_30");
    expect(parsed.taxLabel).toBe("VAT");
  });

  it("requires a due date for custom terms, not before the issue date", () => {
    expect(
      invoiceDraftInputSchema.safeParse({ ...draft, terms: "custom" }).success,
    ).toBe(false);
    expect(
      invoiceDraftInputSchema.safeParse({
        ...draft,
        terms: "custom",
        dueOn: "2026-11-01",
      }).success,
    ).toBe(false);
    expect(
      invoiceDraftInputSchema.safeParse({
        ...draft,
        terms: "custom",
        dueOn: "2026-11-02",
      }).success,
    ).toBe(true);
  });

  it("refuses a due date with fixed terms", () => {
    expect(
      invoiceDraftInputSchema.safeParse({ ...draft, dueOn: "2026-12-01" })
        .success,
    ).toBe(false);
  });

  it.each(["", "has space", "-lead", "x".repeat(33)])(
    "rejects number %j",
    (number) => {
      expect(
        invoiceDraftInputSchema.safeParse({ ...draft, number }).success,
      ).toBe(false);
    },
  );

  it("allows - / _ . in a number", () => {
    expect(
      invoiceDraftInputSchema.safeParse({ ...draft, number: "AC/2026_1-a.b" })
        .success,
    ).toBe(true);
  });

  it("needs 1 to 50 lines", () => {
    expect(
      invoiceDraftInputSchema.safeParse({ ...draft, lines: [] }).success,
    ).toBe(false);
    expect(
      invoiceDraftInputSchema.safeParse({
        ...draft,
        lines: Array.from({ length: 51 }, () => draft.lines[0]),
      }).success,
    ).toBe(false);
  });

  it("bounds the tax rate to 0-10000 basis points", () => {
    for (const taxRateBps of [-1, 10_001, 1.5]) {
      expect(
        invoiceDraftInputSchema.safeParse({ ...draft, taxRateBps }).success,
      ).toBe(false);
    }
    expect(
      invoiceDraftInputSchema.safeParse({ ...draft, taxRateBps: 1600 }).success,
    ).toBe(true);
  });
});

describe("other inputs", () => {
  it("validates a customer", () => {
    expect(
      customerInputSchema.safeParse({ name: "Acme", email: "ap@acme.test" })
        .success,
    ).toBe(true);
    expect(
      customerInputSchema.safeParse({ name: "Acme", email: "nope" }).success,
    ).toBe(false);
  });

  it("validates a mark-paid date", () => {
    expect(
      invoiceMarkPaidSchema.safeParse({ paidOn: "2026-13-01" }).success,
    ).toBe(false);
    expect(
      invoiceMarkPaidSchema.safeParse({ paidOn: "2026-11-05" }).success,
    ).toBe(true);
  });
});
