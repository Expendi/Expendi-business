import { describe, expect, it } from "vitest";

import type { PaymentStatuses } from "@expendi-business/shared";
import { paymentPollInterval } from "@expendi-business/shared";

import {
  billListStatuses,
  billStatuses,
  claimPagesStatuses,
  claimStatuses,
  floatListStatuses,
  floatStatuses,
  inFlightCount,
  mySalaryPaymentStatuses,
  overviewPersonStatuses,
  payrollRunListStatuses,
  payrollRunStatuses,
  refreshedWhenSettled,
  walletHistoryStatuses,
} from "./payment-poll";

const ORG = "11111111-1111-4111-8111-111111111111";

/** How often each screen's data is asked about again: in flight, settled, not loaded. */
function intervals(
  inFlight: PaymentStatuses,
  settled: PaymentStatuses,
  notLoaded: PaymentStatuses,
): (number | false)[] {
  return [inFlight, settled, notLoaded].map(paymentPollInterval);
}

describe("asking again while a payment is on its way", () => {
  it("follows a bill list and a bill being paid", () => {
    // #then
    expect(
      intervals(
        billListStatuses([{ status: "due" }, { status: "paying" }]),
        billListStatuses([{ status: "due" }, { status: "payout_failed" }]),
        billListStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
    expect(
      intervals(
        billStatuses({ status: "paying" }),
        billStatuses({ status: "paid" }),
        billStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });

  it("follows every loaded page of claims", () => {
    // #then
    expect(
      intervals(
        claimPagesStatuses({
          pages: [
            { claims: [{ status: "submitted" }] },
            { claims: [{ status: "paying" }] },
          ],
        }),
        claimPagesStatuses({
          pages: [{ claims: [{ status: "paid" }, { status: "rejected" }] }],
        }),
        claimPagesStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });

  it("follows a claim and its payout", () => {
    // #then
    expect(
      intervals(
        claimStatuses({ status: "paying", payout: { status: "funding" } }),
        claimStatuses({ status: "paid", payout: { status: "paid" } }),
        claimStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
    expect(
      paymentPollInterval(claimStatuses({ status: "paying", payout: null })),
    ).toBe(5000);
  });

  it("follows payroll runs and each payment in a run", () => {
    // #then
    expect(
      intervals(
        payrollRunListStatuses([{ status: "paid" }, { status: "paying" }]),
        payrollRunListStatuses([{ status: "draft" }, { status: "paid" }]),
        payrollRunListStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
    expect(
      intervals(
        payrollRunStatuses({
          status: "partly_failed",
          payments: [{ status: "payout_failed" }, { status: "paying" }],
        }),
        payrollRunStatuses({
          status: "partly_failed",
          payments: [{ status: "payout_failed" }, { status: "paid" }],
        }),
        payrollRunStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });

  it("follows a person's own salary payments", () => {
    // #then
    expect(
      intervals(
        mySalaryPaymentStatuses([{ status: "paying" }]),
        mySalaryPaymentStatuses([
          { status: "paid" },
          { status: "payout_failed" },
        ]),
        mySalaryPaymentStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });

  it("follows floats while money is on its way to a holder", () => {
    // #then
    expect(
      intervals(
        floatListStatuses({
          floats: [{ onTheWayKes: "0" }, { onTheWayKes: "500000" }],
        }),
        floatListStatuses({ floats: [{ onTheWayKes: "0" }] }),
        floatListStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });

  it("follows a float's issues, top-ups and overspend claims", () => {
    // #then
    expect(
      intervals(
        floatStatuses({
          movements: [{ phase: "paid" }, { phase: "on_its_way" }],
          overspendClaims: [],
        }),
        floatStatuses({
          movements: [{ phase: "awaiting_approval" }, { phase: "paid" }],
          overspendClaims: [{ status: "submitted" }],
        }),
        floatStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
    expect(
      paymentPollInterval(
        floatStatuses({
          movements: [],
          overspendClaims: [{ status: "paying" }],
        }),
      ),
    ).toBe(5000);
  });

  it("follows payouts in the wallet history", () => {
    // #then
    expect(
      intervals(
        walletHistoryStatuses({
          pages: [
            {
              items: [
                { payout: null },
                { payout: { status: "order_created" } },
              ],
            },
          ],
        }),
        walletHistoryStatuses({
          pages: [
            {
              items: [
                { payout: { status: "paid" } },
                { payout: { status: "awaiting_approval" } },
                { payout: { status: "needs_review" } },
              ],
            },
          ],
        }),
        walletHistoryStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });

  it("follows the claims on the overview's sheet for one person", () => {
    // #then
    expect(
      intervals(
        overviewPersonStatuses({ claims: [{ status: "paying" }] }),
        overviewPersonStatuses({
          claims: [{ status: "paid" }, { status: "something_new" }],
        }),
        overviewPersonStatuses(undefined),
      ),
    ).toEqual([5000, false, false]);
  });
});

describe("noticing a payment settle", () => {
  it("counts each payment on its way", () => {
    // #then
    expect(
      inFlightCount({
        bills: ["paying", "paying", "paid"],
        claims: ["paying"],
        payrollRuns: ["paying"],
        floatMovements: ["on_its_way", "awaiting_approval"],
        payouts: ["funding", "needs_review"],
      }),
    ).toBe(6);
    expect(inFlightCount({})).toBe(0);
  });

  it("fetches the wallet balance again, never its history twice", () => {
    // #then
    expect(refreshedWhenSettled("wallet_history", ORG)).toEqual([
      { queryKey: ["organizations", ORG, "wallet"], exact: true },
    ]);
  });

  it("fetches the screen's lists, counts and the wallet again", () => {
    // #then
    expect(refreshedWhenSettled("bills", ORG)).toEqual([
      { queryKey: ["organizations", ORG, "bills"] },
      { queryKey: ["organizations", ORG, "recurring-items"] },
      { queryKey: ["organizations", ORG, "wallet"], exact: true },
      { queryKey: ["organizations", ORG, "wallet", "history"] },
    ]);
    expect(
      refreshedWhenSettled("payroll", ORG).map((filters) => filters.queryKey),
    ).toEqual([
      ["organizations", ORG, "payroll"],
      ["organizations", ORG, "my-salary-payments"],
      ["organizations", ORG, "bills"],
      ["organizations", ORG, "wallet"],
      ["organizations", ORG, "wallet", "history"],
    ]);
  });
});
