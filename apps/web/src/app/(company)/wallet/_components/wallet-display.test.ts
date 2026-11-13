import { describe, expect, it } from "vitest";

import type { WalletHistoryItem } from "@expendi-business/shared";

import { LEDGER } from "~/app/dev/preview/_harness/fixtures/wallet";
import { paymentSteps } from "./tx-sheet";
import {
  approvedAlongside,
  dailyBalances,
  dayHeading,
  filterHistory,
  groupByDay,
  maxWithdrawal,
  monthFlows,
  nairobiDay,
  rowBadge,
  signedUsdc,
  splitUsdc,
  txDetail,
  txTitle,
} from "./wallet-display";

const TODAY = "2026-11-06";

function find(title: string, type?: WalletHistoryItem["type"]) {
  const item = LEDGER.find(
    (row) =>
      txTitle(row) === title && (type === undefined || row.type === type),
  );
  if (!item) throw new Error(`No sample row called ${title}`);
  return item;
}

describe("the ledger's days", () => {
  it("names today, yesterday, then the weekday", () => {
    // #when
    const headings = ["2026-11-06", "2026-11-05", "2026-11-04"].map((day) =>
      dayHeading(day, TODAY),
    );

    // #then
    expect(headings).toEqual(["Today", "Yesterday", "Wednesday 4 Nov"]);
  });

  it("counts a moment by its Nairobi day, not UTC's", () => {
    // #when
    const day = nairobiDay("2026-10-31T21:30:00Z");

    // #then
    expect(day).toBe("2026-11-01");
  });

  it("groups rows under their day, newest first", () => {
    // #when
    const days = groupByDay(LEDGER.slice(0, 9)).map((group) => [
      group.day,
      group.items.length,
    ]);

    // #then
    expect(days).toEqual([
      ["2026-11-06", 2],
      ["2026-11-05", 2],
      ["2026-11-04", 3],
      ["2026-11-03", 1],
      ["2026-11-01", 1],
    ]);
  });
});

describe("money in and out", () => {
  it("adds this month's money in and out apart", () => {
    // #when
    const flows = monthFlows(LEDGER, "2026-11");

    // #then
    expect({ in: signedUsdc(flows.in), out: signedUsdc(flows.out) }).toEqual({
      in: "+6,031.78",
      out: "−4,257.75",
    });
  });

  it("filters money in and money out by sign", () => {
    // #when
    const moneyIn = filterHistory(LEDGER, "in").map((row) => row.type);
    const moneyOut = filterHistory(LEDGER, "out").length;

    // #then
    expect({
      moneyIn: [...new Set(moneyIn)].sort(),
      moneyOut,
      all: filterHistory(LEDGER, "all").length,
    }).toEqual({ moneyIn: ["deposit", "refund"], moneyOut: 15, all: 20 });
  });

  it("walks the balance back day by day from today's", () => {
    // #when
    const series = dailyBalances("16420800000", LEDGER, TODAY);

    // #then
    expect({
      days: series.length,
      first: series[0]?.day,
      today: series.at(-1),
      endOf5Nov: series.find((point) => point.day === "2026-11-05")?.units,
      endOf27Oct: series.find((point) => point.day === "2026-10-27")?.units,
      endOf28Oct: series.find((point) => point.day === "2026-10-28")?.units,
    }).toEqual({
      days: 31,
      first: "2026-10-07",
      today: { day: TODAY, units: "16420800000" },
      endOf5Nov: "18017700000",
      endOf27Oct: "12259170000",
      endOf28Oct: "2646770000",
    });
  });
});

describe("a ledger row", () => {
  it("says who was paid and what for, or where money came from", () => {
    // #when
    const lines = [
      find("Twiga Foods"),
      find("Deposit"),
      find("Refund"),
      find("Withdrawal"),
      find("Wanjiru Kamau"),
    ].map((row) => [txTitle(row), txDetail(row)]);

    // #then
    expect(lines).toEqual([
      ["Twiga Foods", "KES 186,000 · Bill"],
      ["Deposit", "From mwangaza-treasury.near"],
      ["Refund", "Zuku payment failed, money returned"],
      ["Withdrawal", "To Treasury on Coinbase"],
      ["Wanjiru Kamau", "KES 260,000 · Payroll"],
    ]);
  });

  it("tints the badge of a payment still moving or failed", () => {
    // #when
    const badges = [
      find("Twiga Foods"),
      find("Kevin Mwangi"),
      find("Zuku", "payout"),
    ].map((row) => {
      const badge = rowBadge(row);
      return [badge?.label, badge?.tone];
    });

    // #then
    expect(badges).toEqual([
      ["On its way", "moving"],
      ["Sending", "moving"],
      ["Failed", "failed"],
    ]);
  });

  it("gives every settled row a quiet badge", () => {
    // #when
    const badges = [
      find("Deposit"),
      find("Refund"),
      find("Kenya Power"),
      find("Withdrawal"),
    ].map((row) => {
      const badge = rowBadge(row);
      return [badge?.label, badge?.tone];
    });

    // #then
    expect(badges).toEqual([
      ["Received", "quiet"],
      ["Received", "quiet"],
      ["Paid", "quiet"],
      ["Sent", "quiet"],
    ]);
  });

  it("counts the other payments approved with the same passkey", () => {
    // #when
    const counts = [
      find("Twiga Foods"),
      find("Wanjiru Kamau"),
      find("Zuku"),
    ].map((row) => approvedAlongside(row, LEDGER));

    // #then
    expect(counts).toEqual([1, 4, 0]);
  });

  it("shows a payment's progress, or where it failed", () => {
    // #when
    const moving = paymentSteps(find("Twiga Foods")).map(
      (step) => `${step.label}:${step.state}`,
    );
    const failed = paymentSteps(find("Zuku", "payout")).map(
      (step) => `${step.label}:${step.state}`,
    );
    const paid = paymentSteps(find("Kenya Power")).every(
      (step) => step.state === "done",
    );

    // #then
    expect({ moving, failed, paid }).toEqual({
      moving: [
        "Approved:done",
        "Sending:done",
        "On its way:current",
        "Paid:pending",
      ],
      failed: ["Approved:done", "Sending:done", "Failed:failed"],
      paid: true,
    });
  });
});

describe("USDC figures", () => {
  it("signs money in and out with a plus and a true minus", () => {
    // #then
    expect([signedUsdc("6000000000"), signedUsdc("-1441860000")]).toEqual([
      "+6,000.00",
      "−1,441.86",
    ]);
  });

  it("splits the cents off so they can be muted", () => {
    // #then
    expect(splitUsdc("16420800000")).toEqual(["16,420", ".80"]);
  });

  it("offers the balance as the most to withdraw, rounded down to the cent", () => {
    // #then
    expect([maxWithdrawal("16420809999"), maxWithdrawal("5000")]).toEqual([
      "16420.80",
      "0.00",
    ]);
  });
});
