import { describe, expect, it } from "vitest";

import type { InvoiceDraft } from "./invoice-draft";
import {
  blankDraft,
  blankLine,
  dueDateOf,
  toDraftRequest,
} from "./invoice-draft";

const CUSTOMER = "00000000-0000-4000-8000-000000000101";

function draftWith(changes: Partial<InvoiceDraft>): InvoiceDraft {
  const base = blankDraft("2026-11-06");
  return {
    ...base,
    customerId: CUSTOMER,
    lines: [
      {
        ...blankLine(),
        description: "Route audit",
        quantity: "2.5",
        unitPrice: "333",
      },
    ],
    ...changes,
  };
}

describe("an invoice draft as a request", () => {
  it("sends dollars as exact cents, net 30 terms with no due date, and tax as basis points", () => {
    // #when
    const result = toDraftRequest(
      draftWith({ taxRate: "16", note: " Thank you " }),
      "INV-0007",
    );

    // #then
    expect(result).toEqual({
      ok: true,
      request: {
        customerId: CUSTOMER,
        number: "INV-0007",
        issueOn: "2026-11-06",
        terms: "net_30",
        lines: [
          {
            description: "Route audit",
            quantity: "2.5",
            unitPriceCents: "33300",
          },
        ],
        taxRateBps: 1600,
        taxLabel: "VAT",
        note: "Thank you",
      },
    });
  });

  it("sends the due date only for a custom date, and leaves tax out without a rate", () => {
    // #when
    const result = toDraftRequest(
      draftWith({ terms: "custom", dueOn: "2026-12-01" }),
      "INV-0008",
    );

    // #then
    expect(result).toMatchObject({
      ok: true,
      request: { terms: "custom", dueOn: "2026-12-01" },
    });
    expect(result.ok && "taxRateBps" in result.request).toBe(false);
  });

  it("names each problem: customer, a bad price on its line, a custom date not chosen", () => {
    // #given
    const draft = draftWith({
      customerId: null,
      terms: "custom",
      lines: [
        {
          ...blankLine(),
          description: "Audit",
          quantity: "1",
          unitPrice: "12.345",
        },
      ],
    });

    // #when
    const result = toDraftRequest(draft, "INV-0009");

    // #then
    const key = draft.lines[0]?.key ?? "";
    expect(result).toEqual({
      ok: false,
      errors: {
        fields: { customer: "Choose a customer.", dueOn: "Choose a due date." },
        lines: { [key]: "Enter the unit price in dollars, like 120 or 49.99." },
        linesSummary: undefined,
        form: undefined,
      },
    });
  });

  it("asks for a line when there are none, and rejects a rate above 100", () => {
    // #when
    const result = toDraftRequest(
      draftWith({ lines: [], taxRate: "150" }),
      "INV-0010",
    );

    // #then
    expect(result).toMatchObject({
      ok: false,
      errors: {
        fields: { taxRate: "Enter a rate between 0 and 100, like 16 or 7.5." },
        linesSummary: "Add at least one line.",
      },
    });
  });

  it("works out the due date from the terms", () => {
    // #then
    expect([
      dueDateOf(draftWith({ terms: "on_receipt" })),
      dueDateOf(draftWith({ terms: "net_15" })),
      dueDateOf(draftWith({ terms: "net_30" })),
      dueDateOf(draftWith({ terms: "custom", dueOn: "" })),
      dueDateOf(draftWith({ terms: "custom", dueOn: "2027-01-02" })),
    ]).toEqual(["2026-11-06", "2026-11-21", "2026-12-06", null, "2027-01-02"]);
  });
});
