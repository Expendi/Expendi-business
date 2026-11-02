import { describe, expect, it } from "vitest";

import type { Bill, BillStatus } from "@expendi-business/shared";

import type { BillDraft } from "./bill-draft";
import { formatBillAmount } from "./bill-amount";
import {
  amountChanged,
  centsToTyped,
  draftFromBill,
  toCreateRequest,
  toUpdateRequest,
} from "./bill-draft";
import {
  groupOpenBills,
  historyNewestFirst,
  shiftIsoDate,
} from "./bill-groups";

let nextId = 0;

function bill(overrides: Partial<Bill> = {}): Bill {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    status: "upcoming",
    payee: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Kenya Power",
      kind: "supplier",
      method: "mpesa_paybill",
      archived: false,
    },
    overviewHeading: "transactions",
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Utilities" },
    variable: false,
    currency: "kes",
    amountKes: "1500050",
    amountUsdc: null,
    reference: "INV-1",
    notes: null,
    dueOn: "2026-11-10",
    recurringItemId: null,
    payrollRunId: null,
    adjustmentReason: null,
    paidOn: null,
    paidAt: null,
    markedPaidBy: null,
    paidOutsideNote: null,
    cancelledReason: null,
    cancelledAt: null,
    cancelledBy: null,
    payoutId: null,
    fileCount: 0,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("groupOpenBills", () => {
  it("puts overdue first, then due, then upcoming, and drops empty groups", () => {
    // #given
    const bills = (
      ["upcoming", "due", "overdue", "upcoming"] as BillStatus[]
    ).map((status) => bill({ status }));

    // #when
    const groups = groupOpenBills(bills);

    // #then
    expect(groups.map((group) => [group.title, group.bills.length])).toEqual([
      ["Overdue", 1],
      ["Due today", 1],
      ["Upcoming", 2],
    ]);
  });
});

describe("historyNewestFirst", () => {
  it("orders paid and cancelled bills by the day they were settled", () => {
    // #given
    const paidEarly = bill({ status: "paid_outside", paidOn: "2026-10-01" });
    const cancelled = bill({
      status: "cancelled",
      cancelledAt: "2026-10-20T08:00:00.000Z",
    });
    const paidLate = bill({ status: "paid_outside", paidOn: "2026-10-28" });

    // #when
    const ordered = historyNewestFirst([paidEarly, cancelled, paidLate]);

    // #then
    expect(ordered.map((entry) => entry.id)).toEqual([
      paidLate.id,
      cancelled.id,
      paidEarly.id,
    ]);
  });
});

describe("shiftIsoDate", () => {
  it.each([
    ["2026-11-02", -180, "2026-05-06"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-12-31", 1, "2027-01-01"],
  ])("%s moved %i days is %s", (date, days, expected) => {
    // #when
    const shifted = shiftIsoDate(date, days);

    // #then
    expect(shifted).toBe(expected);
  });
});

describe("centsToTyped", () => {
  it.each([
    ["1500050", "15000.50"],
    ["5", "0.05"],
    ["100", "1.00"],
  ])("shows %s cents as %s", (cents, typed) => {
    // #when
    const result = centsToTyped(cents);

    // #then
    expect(result).toBe(typed);
  });
});

describe("toCreateRequest", () => {
  it("sends blank optional fields as null and lets the payee pick the heading", () => {
    // #given
    const draft: BillDraft = {
      payeeId: "11111111-1111-4111-8111-111111111111",
      variable: true,
      currency: "kes",
      amount: " ",
      dueOn: " 2026-11-30 ",
      heading: null,
      categoryId: "22222222-2222-4222-8222-222222222222",
      reference: "",
      notes: "",
      adjustmentReason: "",
    };

    // #when
    const request = toCreateRequest(draft, []);

    // #then
    expect(request).toEqual({
      payeeId: draft.payeeId,
      variable: true,
      amountKes: null,
      dueOn: "2026-11-30",
      overviewHeading: undefined,
      categoryId: draft.categoryId,
      reference: null,
      notes: null,
      invoiceFileIds: [],
    });
  });
});

describe("toUpdateRequest", () => {
  it("sends nothing when nothing changed", () => {
    // #given
    const existing = bill();

    // #when
    const request = toUpdateRequest(existing, draftFromBill(existing));

    // #then
    expect(request).toEqual({});
  });

  it("treats the same amount typed differently as unchanged", () => {
    // #given
    const existing = bill();
    const draft = { ...draftFromBill(existing), amount: "15,000.5" };

    // #when
    const changed = amountChanged(existing, draft);

    // #then
    expect(changed).toBe(false);
  });

  it("sends a fixed bill's new amount with the reason", () => {
    // #given
    const existing = bill();
    const draft = {
      ...draftFromBill(existing),
      amount: "16,000",
      adjustmentReason: "Late fee",
    };

    // #when
    const request = toUpdateRequest(existing, draft);

    // #then
    expect(request).toEqual({
      amountKes: "16,000",
      adjustmentReason: "Late fee",
    });
  });

  it("sends a variable bill's amount without a reason", () => {
    // #given
    const existing = bill({ variable: true, amountKes: null });
    const draft = { ...draftFromBill(existing), amount: "48,250" };

    // #when
    const request = toUpdateRequest(existing, draft);

    // #then
    expect(request).toEqual({ amountKes: "48,250" });
  });

  it("clears a reference that was emptied", () => {
    // #given
    const existing = bill();
    const draft = { ...draftFromBill(existing), reference: "  " };

    // #when
    const request = toUpdateRequest(existing, draft);

    // #then
    expect(request).toEqual({ reference: null });
  });
});

describe("bills to a payee paid in USDC (spec §6.19)", () => {
  const usdcPayee = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Vercel",
    kind: "vendor" as const,
    method: "usdc" as const,
    archived: false,
  };

  it("are typed and sent in USD", () => {
    // #given
    const existing = bill({
      payee: usdcPayee,
      currency: "usd",
      amountKes: null,
      amountUsdc: "120500000",
    });
    const draft = {
      ...draftFromBill(existing),
      amount: "130",
      adjustmentReason: "Seats",
    };

    // #when
    const request = toUpdateRequest(existing, draft);

    // #then
    expect({
      typed: draftFromBill(existing).amount,
      label: formatBillAmount(existing),
      request,
    }).toEqual({
      typed: "120.50",
      label: "USD 120.50",
      request: { amountUsd: "130", adjustmentReason: "Seats" },
    });
  });

  it("start blank when the payee moved to USDC after a KES bill was entered", () => {
    // #given
    const existing = bill({ payee: usdcPayee });

    // #when
    const draft = draftFromBill(existing);

    // #then
    expect({ currency: draft.currency, amount: draft.amount }).toEqual({
      currency: "usd",
      amount: "",
    });
  });

  it("send a new bill's amount as amountUsd", () => {
    // #given
    const draft: BillDraft = {
      ...draftFromBill(bill()),
      currency: "usd",
      amount: "75.25",
    };

    // #when
    const request = toCreateRequest(draft, []);

    // #then
    expect({ usd: request.amountUsd, kes: request.amountKes }).toEqual({
      usd: "75.25",
      kes: undefined,
    });
  });
});
