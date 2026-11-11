import { describe, expect, it } from "vitest";

import type { FundIn } from "@expendi-business/shared";
import { FUND_IN_STATUSES } from "@expendi-business/shared";

import {
  FUND_IN_STATUS,
  fundInDraft,
  fundInPollInterval,
  isFinalFundIn,
} from "./fund-in";

const fundIn: FundIn = {
  id: "00000000-0000-4000-8000-000000000621",
  chain: "base",
  amountIn: "2500000000",
  amountOut: "2499870000",
  depositAddress: "0x9d4c1e7a2b5f8036c1d4e7a9b2c5f8e1d4a7b0c3",
  deadline: "2026-11-06T08:30:00.000Z",
  status: "awaiting_deposit",
  createdAt: "2026-11-06T06:30:00.000Z",
};

describe("starting a fund-in from another chain", () => {
  it("asks for the chain and the amount in base units", () => {
    // #when
    const draft = fundInDraft("arbitrum", "2500.5");

    // #then
    expect(draft).toEqual({
      ok: true,
      request: { chain: "arbitrum", amount: "2500500000" },
    });
  });

  it("refuses an amount that isn't a positive USDC amount", () => {
    // #when
    const drafts = [
      fundInDraft("base", ""),
      fundInDraft("base", "0"),
      fundInDraft("base", "1.0000001"),
    ];

    // #then
    expect(drafts.map((draft) => (draft.ok ? "ok" : draft.errors))).toEqual([
      { amount: "Enter an amount in USDC." },
      { amount: "Enter an amount above zero." },
      { amount: "USDC has at most 6 decimal places." },
    ]);
  });
});

describe("following a fund-in", () => {
  it("keeps asking until the fund-in is final", () => {
    // #then
    expect(
      FUND_IN_STATUSES.map((status) => [
        status,
        isFinalFundIn(status),
        fundInPollInterval({ ...fundIn, status }),
      ]),
    ).toEqual([
      ["awaiting_deposit", false, 5000],
      ["processing", false, 5000],
      ["completed", true, false],
      ["returning", false, 5000],
      ["returned", true, false],
      ["refunded", true, false],
      ["failed", true, false],
      ["expired", true, false],
    ]);
  });

  it("asks again while the fund-in hasn't loaded", () => {
    // #then
    expect(fundInPollInterval(undefined)).toBe(5000);
  });

  it("words every status", () => {
    // #then
    expect(
      FUND_IN_STATUSES.map((status) => [
        FUND_IN_STATUS[status].label,
        FUND_IN_STATUS[status].tone,
      ]),
    ).toEqual([
      ["Waiting for your USDC", "neutral"],
      ["On its way", "neutral"],
      ["In the wallet", "success"],
      ["Returning", "neutral"],
      ["Returned", "warning"],
      ["Refunded", "warning"],
      ["Failed", "warning"],
      ["Expired", "warning"],
    ]);
  });
});
