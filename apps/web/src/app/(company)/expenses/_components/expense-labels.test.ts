import { describe, expect, it } from "vitest";

import { KIND_LABELS as REPORT_KIND_LABELS } from "~/app/(company)/reports/_components/reports-display";
import { expenseKindLabel } from "./expense-labels";

describe("expenseKindLabel", () => {
  it("calls a Card expense a card, even though it's listed with company spending", () => {
    expect({
      card: expenseKindLabel({ kind: "card", listKind: "company" }),
      company: expenseKindLabel({ kind: "company", listKind: "company" }),
      claim: expenseKindLabel({ kind: "claim", listKind: "claim" }),
      float: expenseKindLabel({ kind: "float", listKind: "petty_cash" }),
    }).toEqual({
      card: "Card",
      company: "Company spending",
      claim: "Reimbursement",
      float: "Petty cash",
    });
  });
});

describe("the reports' kind labels", () => {
  it("name a card", () => {
    expect(REPORT_KIND_LABELS.card).toBe("Card");
  });
});
