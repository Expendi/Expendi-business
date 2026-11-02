import { describe, expect, it } from "vitest";

import type {
  FloatMovement,
  FloatPaymentResult,
  FloatSummary,
  Member,
} from "@expendi-business/shared";

import { ApiError } from "../../lib/api";
import {
  balanceRows,
  canHoldFloat,
  existingFloatId,
  floatPaymentOutcome,
  movementAction,
  overspendNotice,
} from "./float-display";

const FLOAT_ID = "0b9f6c1e-3c2a-4d5e-8f70-1a2b3c4d5e6f";

const summary = (changes: Partial<FloatSummary> = {}): FloatSummary => ({
  id: FLOAT_ID,
  status: "open",
  holder: {
    membershipId: "1c0a7d2f-4d3b-4e6f-9a81-2b3c4d5e6f70",
    name: "Jane Wanjiku",
    email: "jane@example.com",
  },
  yours: true,
  openedAt: "2026-11-01T08:00:00.000Z",
  closedAt: null,
  issuedKes: "100000",
  spentKes: "30000",
  returnedKes: "0",
  writtenOffKes: "0",
  leftKes: "70000",
  onTheWayKes: "0",
  awaitingApprovalKes: "0",
  spendingCount: 1,
  noReceiptCount: 0,
  ...changes,
});

const movement = (changes: Partial<FloatMovement> = {}): FloatMovement => ({
  id: "2d1b8e30-5e4c-4f70-8b92-3c4d5e6f7081",
  type: "issue",
  status: "pending",
  phase: "awaiting_approval",
  amountKes: "100000",
  note: null,
  recordedBy: "Ann Admin",
  createdAt: "2026-11-01T08:00:00.000Z",
  paidAt: null,
  payout: null,
  ...changes,
});

describe("overspendNotice", () => {
  it("says nothing while the purchase fits what's left", () => {
    // #when
    const notice = overspendNotice("700", "70000");

    // #then
    expect(notice).toBeNull();
  });

  it("names the part from the float and the part claimed", () => {
    // #when
    const notice = overspendNotice("1,000.50", "70000");

    // #then
    expect(notice).toBe(
      "KES 700.00 comes from your float and KES 300.50 will be submitted as a claim for an admin to approve.",
    );
  });

  it("makes the whole purchase a claim when nothing is left", () => {
    // #when
    const notice = overspendNotice("250", "0");

    // #then
    expect(notice).toBe(
      "Nothing is left on your float, so KES 250.00 will be submitted as a claim for an admin to approve.",
    );
  });

  it("waits for an amount it can read", () => {
    // #when
    const notice = overspendNotice("12,34", "0");

    // #then
    expect(notice).toBeNull();
  });
});

describe("balanceRows", () => {
  it("shows payments on their way and waiting only when there are some", () => {
    // #when
    const rows = balanceRows(
      summary({ onTheWayKes: "50000", returnedKes: "10000" }),
    );

    // #then
    expect(rows.map((row) => row.label)).toEqual([
      "Issued",
      "Spent",
      "Handed back",
      "On its way",
    ]);
  });
});

describe("movementAction", () => {
  it.each([
    { phase: "awaiting_approval", action: "approve" },
    { phase: "failed", action: "retry" },
    { phase: "on_its_way", action: null },
    { phase: "paid", action: null },
    { phase: "recorded", action: null },
  ] as const)("is $action for a movement $phase", ({ phase, action }) => {
    // #when
    const result = movementAction(movement({ phase }));

    // #then
    expect(result).toBe(action);
  });
});

describe("floatPaymentOutcome", () => {
  const result = (changes: Partial<FloatMovement>): FloatPaymentResult => ({
    float: summary(),
    movement: movement(changes),
  });

  it.each([
    {
      changes: { status: "pending", phase: "on_its_way" },
      outcome: "sent",
    },
    { changes: { status: "paid", phase: "paid" }, outcome: "paid" },
    { changes: { status: "failed", phase: "failed" }, outcome: "failed" },
    {
      changes: {
        status: "pending",
        phase: "on_its_way",
        payout: {
          id: "3e2c9f41-6f5d-4081-9ca3-4d5e6f708192",
          status: "needs_review",
          failureReason: null,
        },
      },
      outcome: "review",
    },
  ] as const)("is $outcome", ({ changes, outcome }) => {
    // #when
    const summaryOutcome = floatPaymentOutcome(result(changes));

    // #then
    expect(summaryOutcome).toBe(outcome);
  });
});

describe("canHoldFloat", () => {
  const member = (changes: Partial<Member>): Member => ({
    id: "4f3da052-7a6e-4192-8db4-5e6f708192a3",
    name: "Jane Wanjiku",
    email: "jane@example.com",
    role: "employee",
    status: "active",
    invitedAt: null,
    payoutPhoneConfirmed: true,
    ...changes,
  });

  it("takes an active member with a confirmed M-Pesa number", () => {
    // #when / #then
    expect(canHoldFloat(member({}))).toBe(true);
  });

  it.each([
    { payoutPhoneConfirmed: false },
    { status: "invited" },
    { role: "accountant" },
  ] as const)("refuses %o", (changes) => {
    // #when / #then
    expect(canHoldFloat(member(changes))).toBe(false);
  });
});

describe("existingFloatId", () => {
  it("reads the open float a refused issue points to", () => {
    // #given
    const error = new ApiError(409, "Conflict", "Already has one", {
      floatId: FLOAT_ID,
    });

    // #when / #then
    expect(existingFloatId(error)).toBe(FLOAT_ID);
  });

  it("is null for any other error", () => {
    // #when / #then
    expect(existingFloatId(new Error("offline"))).toBeNull();
  });
});
